"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for through its
503-then-200 health check, its load log becomes the placement note on the
timeline, a completion is streamed and turned into steps and a token meter,
the text and the thought come back apart, and a second job reuses the running
child. That is the part of this arm that can be wrong in ways no amount of
reading catches, and it is the part no GPU is needed to exercise.
"""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_qwen_text.generation import JobError, Sampling, generate, parse_job
from arm_qwen_text.runtime import ChildFailed, LoadConfig
from arm_qwen_text.server import ArmState, Busy

FAKE = Path(__file__).parent / "fake_llama_server.py"


@dataclass
class FakeConfig(LoadConfig):
    """The real config, invoked through the interpreter instead of a binary.

    Overriding `argv` rather than adding a hook to it: the production path has
    no reason to run anything but the executable it was given, and a seam there
    would exist only for this file.
    """

    def argv(self, host: str, port: int) -> list[str]:
        return [sys.executable, str(FAKE), *super().argv(host, port)[1:]]


def config_for(tmp_path: Path) -> FakeConfig:
    model = tmp_path / "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
    model.write_bytes(b"GGUF")
    return FakeConfig(server_binary=FAKE, model=model, ready_timeout_seconds=30.0)


@pytest.fixture
def arm(tmp_path: Path):
    state = ArmState(config_for(tmp_path))
    try:
        yield state
    finally:
        state.shutdown()


def test_a_completion_comes_back_with_its_thought_apart(arm: ArmState) -> None:
    report = arm.run({"jobId": "job-1", "prompt": "one two three"})

    assert report["text"] == "three two one"
    assert report["reasoning"] == "Let me think."
    assert report["finish_reason"] == "stop"
    assert report["thinking"] is True
    assert report["tokens_generated"] == 7
    assert report["tokens_reasoning"] == 4
    assert report["tokens_prompt"] == 11
    assert report["model"] == "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
    assert report["context_size"] == 65536
    assert report["sampling"]["temperature"] == 1.0
    # Every VRAM figure says what it measured. A whole-card peak filed as this
    # arm's own share would overstate it by whatever else was on the GPU.
    assert report["vram_scope"] in {"process", "card", "unavailable"}
    assert report["seconds_to_first_token"] > 0
    assert [stage["name"] for stage in report["stages"]] == ["prompt", "think", "answer"]


def test_thinking_off_means_no_thought_at_all(arm: ArmState) -> None:
    report = arm.run({"jobId": "job-2", "prompt": "a b", "thinking": False})

    assert report["text"] == "b a"
    assert report["reasoning"] is None
    assert report["tokens_reasoning"] == 0
    assert report["sampling"]["temperature"] == 0.7
    assert [stage["name"] for stage in report["stages"]] == ["prompt", "answer"]


def test_the_timeline_carries_the_load_and_the_stream(arm: ArmState) -> None:
    arm.run({"jobId": "job-3", "prompt": "x y z", "maxTokens": 50})

    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-3"
    steps = {step["key"]: step for step in snapshot["steps"]}

    assert steps["start"]["state"] == "done"
    load = {child["key"]: child for child in steps["start"]["children"]}["load"]
    assert load["state"] == "done"
    # Where the weights went, read out of the child's log: the one thing the
    # API never says.
    assert load["note"] == "41/41 layers on GPU · CPU 10.6 GiB · CUDA0 10.2 GiB"
    assert arm.server.placement.kv_mib == 1280.0

    assert steps["generate"]["state"] == "done"
    labels = [child["label"] for child in steps["generate"]["children"]]
    assert labels == ["Prompt processing", "Think", "Answer"]

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert meters["tokens"]["total"] == 50
    assert meters["tokens"]["done"] == 7
    assert meters["tokens"]["detail"].endswith("tok/s")
    # A short prompt's exact length arrives with the first token.
    assert (meters["prompt"]["done"], meters["prompt"]["total"]) == (11, 11)


def test_a_long_prompt_reports_its_progress_from_the_log(arm: ArmState) -> None:
    words = " ".join(["word"] * 5000)
    arm.run({"jobId": "job-4", "prompt": words, "maxTokens": 8})

    meters = {meter["key"]: meter for meter in arm.progress.snapshot()["meters"]}
    assert meters["prompt"]["total"] == 5008
    assert meters["prompt"]["done"] == 5008


def test_a_second_job_reuses_the_running_child(arm: ArmState) -> None:
    arm.run({"jobId": "job-5", "prompt": "one"})
    pid = arm.server.pid
    assert pid is not None

    arm.run({"jobId": "job-6", "prompt": "two"})
    assert arm.server.pid == pid

    # And the second job's timeline has no start step: the child was up.
    keys = [step["key"] for step in arm.progress.snapshot()["steps"]]
    assert keys == ["generate"]


def test_max_tokens_truncates_with_the_reason_kept(arm: ArmState) -> None:
    report = arm.run({"jobId": "job-7", "prompt": "one two three four five", "maxTokens": 3})
    assert report["finish_reason"] == "length"
    assert report["tokens_generated"] == 3


def test_a_bad_job_is_refused_before_the_child_is_started(arm: ArmState) -> None:
    with pytest.raises(JobError):
        arm.run({"jobId": "job-8"})
    assert arm.server.pid is None


def test_the_childs_own_refusal_reaches_the_caller(arm: ArmState) -> None:
    # Validation here allows up to 2.0; the stand-in refuses above 5.0, which
    # is the shape of any 400 the real child returns for a request it will not
    # run. Reached by going around `parse_job`, since it would not let this by.
    arm.run({"jobId": "job-9", "prompt": "warm up"})
    job = parse_job({"prompt": "x"}, 65536)
    job.sampling = Sampling(9.0, 0.95, 20, 0.0, 1.5, 1.0)
    with pytest.raises(ChildFailed, match="400"):
        generate(arm.server, job, arm.progress)


def test_a_missing_model_is_named(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.model = tmp_path / "not-there.gguf"
    state = ArmState(config)
    try:
        with pytest.raises(ChildFailed, match=r"not-there\.gguf is not there"):
            state.run({"jobId": "job-10", "prompt": "x"})
    finally:
        state.shutdown()


def test_a_missing_binary_is_named(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.server_binary = tmp_path / "llama-server.exe"
    state = ArmState(config)
    try:
        with pytest.raises(ChildFailed, match=r"llama-server\.exe is not there"):
            state.run({"jobId": "job-11", "prompt": "x"})
    finally:
        state.shutdown()


def test_two_jobs_at_once_is_a_busy_not_a_queue(arm: ArmState) -> None:
    started = threading.Event()
    results: list[object] = []

    def slow() -> None:
        started.set()
        results.append(arm.run({"jobId": "job-12", "prompt": " ".join(["w"] * 400), "maxTokens": 400}))

    thread = threading.Thread(target=slow)
    thread.start()
    started.wait()
    # The stand-in emits a token every few milliseconds, so the first job is
    # still streaming when the second arrives.
    time.sleep(0.15)
    with pytest.raises(Busy):
        arm.run({"jobId": "job-13", "prompt": "x"})
    thread.join()
    assert results

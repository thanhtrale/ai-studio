"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, a job is submitted and polled, the images come back
base64 and are written where the caller asked. That is the part of this arm
that can be wrong in ways no amount of reading catches, and it is the part no
GPU is needed to exercise.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError

import pytest

from arm_qwen_edit.generation import JobError, generate, parse_job
from arm_qwen_edit.runtime import ChildFailed, LoadConfig, SdServer
from arm_qwen_edit.server import ArmState

FAKE = Path(__file__).parent / "fake_sd_server.py"


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
    return FakeConfig(
        server_binary=FAKE,
        diffusion_model=tmp_path / "qwen-image-edit-2511-Q4_K_M.gguf",
        vae=tmp_path / "vae.safetensors",
        llm=tmp_path / "llm.safetensors",
        llm_vision=None,
        ready_timeout_seconds=30.0,
    )


@pytest.fixture
def arm(tmp_path: Path):
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    state = ArmState(config_for(tmp_path), out_dir, in_dir)
    try:
        yield state
    finally:
        state.shutdown()


def test_a_single_image_run(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run({"jobId": "job-1", "prompt": "a cat", "outPath": "2026-09-11/a.png", "seed": 42})

    written = tmp_path / "outputs" / "2026-09-11" / "a.png"
    assert written.is_file()
    assert written.read_bytes().startswith(b"\x89PNG")

    assert report["batch"] == 1
    assert len(report["images"]) == 1
    assert report["images"][0]["out_path"] == str(written)
    assert report["images"][0]["out_bytes"] == written.stat().st_size
    # The seed the child actually used, read out of its log -- which is the
    # only place it exists when the request asked for -1.
    assert report["seed"] == 42
    assert report["steps"] == 4


def test_a_batch_writes_one_file_per_image_with_its_own_seed(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(
        {"jobId": "job-2", "prompt": "a cat", "outPath": "2026-09-11/b.png", "batch": 3, "seed": 100}
    )

    folder = tmp_path / "outputs" / "2026-09-11"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.png", "b-3.png", "b.png"]
    assert [image["seed"] for image in report["images"]] == [100, 101, 102]
    assert [image["index"] for image in report["images"]] == [0, 1, 2]


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run({"jobId": "job-3", "prompt": "a cat", "outPath": "c.png", "steps": 6})

    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-3"

    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    # The phases the child announced, as children of the job's own step.
    labels = {child["label"] for child in steps["generate"].get("children", [])}
    assert {"Encode prompt", "Sample", "Decode"} <= labels

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert meters["steps"]["total"] == 6
    assert meters["steps"]["done"] == 6


def test_a_second_job_reuses_the_running_child(arm: ArmState) -> None:
    arm.run({"jobId": "job-4", "prompt": "one", "outPath": "d.png"})
    first = arm.server.pid

    arm.run({"jobId": "job-5", "prompt": "two", "outPath": "e.png"})

    # The whole reason this arm drives the server build rather than the CLI:
    # the second job does not pay for the model again.
    assert arm.server.pid == first
    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-5"
    assert "start" not in {step["key"] for step in snapshot["steps"]}


def test_references_reach_the_child(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "ref.png").write_bytes(b"\x89PNG\r\n\x1a\nreference")

    report = arm.run(
        {"jobId": "job-6", "prompt": "put the cat on the chair", "outPath": "f.png", "refImages": ["ref.png"]}
    )
    assert len(report["images"]) == 1


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    # Validation happens before the job is opened, on purpose: a rejected job
    # must not wipe the timeline of whatever is actually running.
    with pytest.raises(JobError, match="multiple of 16"):
        arm.run({"jobId": "job-7", "prompt": "a", "outPath": "g.png", "width": 1000})

    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_a_job_the_child_rejects_fails_the_timeline(arm: ArmState) -> None:
    # Everything the arm validates itself is refused before the child sees it,
    # so a refusal by the child has to come from a field passed straight
    # through -- here, the prompt.
    with pytest.raises(HTTPError):
        arm.run({"jobId": "job-8", "prompt": "reject: this one", "outPath": "g.png"})

    snapshot = arm.progress.snapshot()
    failed = {step["key"]: step for step in snapshot["steps"] if step["state"] == "failed"}
    assert "generate" in failed
    assert "HTTPError" in (failed["generate"].get("detail") or "")


def test_a_missing_binary_says_what_to_do(tmp_path: Path) -> None:
    config = LoadConfig(
        server_binary=tmp_path / "bin" / "sd-server.exe",
        diffusion_model=tmp_path / "m.gguf",
        vae=tmp_path / "v.safetensors",
        llm=tmp_path / "l.safetensors",
    )
    server = SdServer(config, ArmState(config, tmp_path, tmp_path).progress)

    with pytest.raises(ChildFailed, match=r"unpack a stable-diffusion\.cpp release"):
        server.start()


def test_parse_job_and_generate_agree_on_the_output_path(arm: ArmState, tmp_path: Path) -> None:
    job = parse_job({"prompt": "a", "outPath": "deep/er/h.png"}, tmp_path / "outputs", tmp_path / "inputs")
    arm.server.start()
    report = generate(arm.server, job, arm.progress)

    # The arm creates the directory it was told to write into; the caller plans
    # a date folder that does not exist yet on the first run of each day.
    assert Path(report.images[0].out_path) == (tmp_path / "outputs" / "deep" / "er" / "h.png")

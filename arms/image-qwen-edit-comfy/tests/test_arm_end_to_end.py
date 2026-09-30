"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, a graph is built and queued, the files ComfyUI
saved are moved into the library's tree. That is the part of this arm that can
be wrong in ways no amount of reading catches, and it is the part no GPU is
needed to exercise.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_qwen_comfy.generation import JobError
from arm_qwen_comfy.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_qwen_comfy.server import ArmState

FAKE = Path(__file__).parent / "fake_comfy.py"


@dataclass
class FakeConfig(LoadConfig):
    """The real config, pointed at a stand-in instead of ComfyUI's main.py.

    Overriding `argv` rather than adding a hook to it: the production path has
    no reason to run anything but the checkout it was given, and a seam there
    would exist only for this file.
    """

    @property
    def main(self) -> Path:
        return FAKE

    def argv(self, host: str, port: int, model_paths: Path) -> list[str]:
        real = super().argv(host, port, model_paths)
        # Same flags, same order, different program: the arm's own argument
        # building is what is under test, so only the script name is replaced.
        return [sys.executable, str(FAKE), *real[2:]]


def config_for(tmp_path: Path) -> FakeConfig:
    models = tmp_path / "models"
    models.mkdir(exist_ok=True)
    return FakeConfig(
        comfy_dir=tmp_path,
        diffusion_model=models / "unet.safetensors",
        text_encoder=models / "clip.safetensors",
        vae=models / "vae.safetensors",
        input_dir=tmp_path / "inputs",
        scratch_dir=tmp_path / "scratch",
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
    report = arm.run(
        {"jobId": "job-1", "prompt": "a cat", "outPath": "2026-09-11/a.png", "seed": 42, "steps": 6}
    )

    written = tmp_path / "outputs" / "2026-09-11" / "a.png"
    assert written.is_file()
    assert written.read_bytes().startswith(b"\x89PNG")

    assert report["batch"] == 1
    assert len(report["images"]) == 1
    assert report["images"][0]["out_path"] == str(written)
    assert report["images"][0]["out_bytes"] == written.stat().st_size
    assert report["seed"] == 42
    assert report["steps"] == 6
    # Every VRAM figure says what it measured. A whole-card peak filed as this
    # arm's own share would overstate it by whatever else was on the GPU.
    assert report["vram_scope"] in {"process", "card", "unavailable"}


def test_the_image_is_moved_out_of_comfy_s_own_output_tree(arm: ArmState, tmp_path: Path) -> None:
    arm.run({"jobId": "job-2", "prompt": "a cat", "outPath": "a.png", "steps": 2})

    # Left in place it would be a generation living in two directories, one of
    # which the studio cleans up without touching the other's record.
    scratch = tmp_path / "scratch" / "output"
    assert list(scratch.rglob("*.png")) == []


def test_a_batch_writes_one_file_per_image_with_its_own_seed(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(
        {
            "jobId": "job-3",
            "prompt": "a cat",
            "outPath": "2026-09-11/b.png",
            "batch": 3,
            "seed": 100,
            "steps": 2,
        }
    )

    folder = tmp_path / "outputs" / "2026-09-11"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.png", "b-3.png", "b.png"]
    assert [image["seed"] for image in report["images"]] == [100, 101, 102]
    assert [image["index"] for image in report["images"]] == [0, 1, 2]

    # The meter counts images as they start, so it would otherwise stop at 2 of
    # 3 on a finished job -- which reads as a batch that lost one.
    meters = {meter["key"]: meter for meter in arm.progress.snapshot()["meters"]}
    assert (meters["batch"]["done"], meters["batch"]["total"]) == (3, 3)


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run({"jobId": "job-4", "prompt": "a cat", "outPath": "c.png", "steps": 6})

    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-4"

    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    # The loads ComfyUI announced, as children of the job's own step.
    children = steps["generate"].get("children", [])
    assert {child["label"] for child in children} >= {"Load text encoder", "Load transformer"}
    # Closed by their own "loaded" line rather than by the end of the job: a
    # load still running when the job finishes reports the job's duration.
    assert all(child["state"] == "done" for child in children)
    assert all(child["seconds"] < steps["generate"]["seconds"] for child in children)

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert (meters["steps"]["done"], meters["steps"]["total"]) == (6, 6)


def test_a_second_job_reuses_the_running_child(arm: ArmState) -> None:
    arm.run({"jobId": "job-5", "prompt": "one", "outPath": "d.png", "steps": 2})
    first = arm.server.pid

    arm.run({"jobId": "job-6", "prompt": "two", "outPath": "e.png", "steps": 2})

    # The whole reason this arm keeps a resident child: the second job does not
    # pay for the model again.
    assert arm.server.pid == first
    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-6"
    assert "start" not in {step["key"] for step in snapshot["steps"]}


def test_references_reach_the_graph(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "ref.png").write_bytes(b"\x89PNG\r\n\x1a\nreference")

    arm.run(
        {
            "jobId": "job-7",
            "prompt": "put the cat on the chair",
            "outPath": "f.png",
            "refImages": ["ref.png"],
            "steps": 2,
        }
    )

    graphs = arm.server.get("/aistudio-test/submitted")["graphs"]
    assert graphs[-1]["ref0"]["inputs"]["image"] == "ref.png"
    assert graphs[-1]["sampler"]["inputs"]["positive"] == ["positive_ref", 0]


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    # Validation happens before the job is opened, on purpose: a rejected job
    # must not wipe the timeline of whatever is actually running.
    with pytest.raises(JobError, match="multiple of 16"):
        arm.run({"jobId": "job-8", "prompt": "a", "outPath": "g.png", "width": 1000})

    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_a_graph_comfy_refuses_fails_the_timeline_with_its_own_words(arm: ArmState) -> None:
    # Everything the arm validates itself is refused before the child sees it,
    # so a refusal by ComfyUI has to come from a field passed straight
    # through -- here, the prompt.
    with pytest.raises(ChildFailed, match="ComfyUI refused the prompt"):
        arm.run({"jobId": "job-9", "prompt": "reject: this one", "outPath": "g.png"})

    snapshot = arm.progress.snapshot()
    failed = {step["key"]: step for step in snapshot["steps"] if step["state"] == "failed"}
    assert "generate" in failed


def test_a_missing_checkout_says_what_to_do(tmp_path: Path) -> None:
    config = LoadConfig(
        comfy_dir=tmp_path / "vendor" / "ComfyUI",
        diffusion_model=tmp_path / "unet.safetensors",
        text_encoder=tmp_path / "clip.safetensors",
        vae=tmp_path / "vae.safetensors",
        input_dir=tmp_path,
        scratch_dir=tmp_path / "scratch",
    )
    server = ComfyServer(config, ArmState(config, tmp_path, tmp_path).progress)

    with pytest.raises(ChildFailed, match="clone ComfyUI into the arm's vendor"):
        server.start()


def test_the_model_search_paths_are_written_for_the_child(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    # Quoted and forward-slashed: a Windows path has a colon in it, which bare
    # would end the YAML key and hand ComfyUI a directory that is not there.
    assert f'diffusion_models: "{models}"' in written
    assert f'text_encoders: "{models}"' in written
    assert f'vae: "{models}"' in written

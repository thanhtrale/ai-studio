"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, a graph is built and queued, the GLB ComfyUI saved
is moved into the library's tree and its counts are read back.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_hy3d.generation import JobError
from arm_hy3d.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_hy3d.server import ArmState

FAKE = Path(__file__).parent / "fake_comfy.py"


@dataclass
class FakeConfig(LoadConfig):
    """The real config, pointed at a stand-in instead of ComfyUI's main.py."""

    @property
    def main(self) -> Path:
        return FAKE

    def argv(self, host: str, port: int, model_paths: Path) -> list[str]:
        real = super().argv(host, port, model_paths)
        return [sys.executable, str(FAKE), *real[2:]]


def config_for(tmp_path: Path) -> FakeConfig:
    models = tmp_path / "models"
    (models / "hy").mkdir(parents=True, exist_ok=True)
    (models / "bg").mkdir(parents=True, exist_ok=True)
    return FakeConfig(
        comfy_dir=tmp_path,
        checkpoint=models / "hy" / "hunyuan_3d_v2.1.safetensors",
        bg_model=models / "bg" / "birefnet.safetensors",
        input_dir=tmp_path / "inputs",
        scratch_dir=tmp_path / "scratch",
    )


@pytest.fixture
def arm(tmp_path: Path):
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    (in_dir / "chair.png").write_bytes(b"\x89PNG\r\n\x1a\nreference")
    state = ArmState(config_for(tmp_path), out_dir, in_dir)
    try:
        yield state
    finally:
        state.shutdown()


def job(**overrides: object) -> dict[str, object]:
    base = {"jobId": "job-1", "outPath": "2026-10-06/a.glb", "refImages": ["chair.png"], "steps": 4}
    return {**base, **overrides}


def test_a_single_mesh_run(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(job(seed=42, targetFaces=40_000))

    written = tmp_path / "outputs" / "2026-10-06" / "a.glb"
    assert written.is_file()
    assert written.read_bytes()[:4] == b"glTF"

    assert report["batch"] == 1
    mesh = report["meshes"][0]
    assert mesh["out_path"] == str(written)
    assert mesh["out_bytes"] == written.stat().st_size
    assert mesh["seed"] == 42
    # Read back from the file, not echoed from the request.
    assert mesh["faces"] == 40_000
    assert mesh["vertices"] == 20_002
    assert report["vram_scope"] in {"process", "card", "unavailable"}


def test_the_mesh_is_moved_out_of_comfy_s_own_output_tree(arm: ArmState, tmp_path: Path) -> None:
    arm.run(job())
    assert list((tmp_path / "scratch" / "output").rglob("*.glb")) == []


def test_a_batch_writes_one_mesh_per_seed(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(job(batch=3, seed=7, outPath="2026-10-06/b.glb"))

    folder = tmp_path / "outputs" / "2026-10-06"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.glb", "b-3.glb", "b.glb"]
    assert [mesh["seed"] for mesh in report["meshes"]] == [7, 8, 9]


def test_the_graph_cuts_the_object_out_and_decimates(arm: ArmState) -> None:
    arm.run(job(targetFaces=50_000))

    graph = arm.server.get("/aistudio-test/submitted")["graphs"][-1]
    assert graph["ref"]["inputs"]["image"] == "chair.png"
    assert graph["vision"]["inputs"]["image"] == ["cutout", 0]
    assert graph["decimate"]["inputs"]["target_face_count"] == 50_000
    assert graph["save"]["inputs"]["mesh"] == ["decimate", 0]


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run(job(steps=6))

    snapshot = arm.progress.snapshot()
    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    children = steps["generate"].get("children", [])
    assert {child["label"] for child in children} >= {"Load image encoder", "Load shape model"}

    # The sampler's bar comes from the websocket, per node, not from the log.
    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert (meters["progress:sampler"]["done"], meters["progress:sampler"]["total"]) == (6, 6)
    assert "steps" not in meters
    nodes = [child["label"] for child in children if child["key"].startswith("node:")]
    assert nodes == [
        "Cut out the object",
        "Crop to the object",
        "Encode the image (DINOv2)",
        "Sample shape",
        "Decode the field",
        "Extract the surface",
        "Turn to face +Z",
        "Write GLB",
    ]


def test_a_second_job_reuses_the_running_child(arm: ArmState) -> None:
    arm.run(job(jobId="job-a"))
    first = arm.server.pid
    arm.run(job(jobId="job-b", outPath="c.glb"))
    assert arm.server.pid == first


def test_no_object_found_is_said_in_words(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "noobject.png").write_bytes(b"\x89PNG\r\n\x1a\nnothing")
    with pytest.raises(ChildFailed, match="found no object"):
        arm.run(job(refImages=["noobject.png"]))


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    with pytest.raises(JobError, match="exactly one image"):
        arm.run(job(refImages=[]))

    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_a_graph_comfy_refuses_fails_the_timeline(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "reject.png").write_bytes(b"\x89PNG\r\n\x1a\nno")
    with pytest.raises(ChildFailed, match="ComfyUI refused the prompt"):
        arm.run(job(refImages=["reject.png"]))

    failed = {step["key"] for step in arm.progress.snapshot()["steps"] if step["state"] == "failed"}
    assert "generate" in failed


def test_a_missing_checkout_says_what_to_do(tmp_path: Path) -> None:
    config = LoadConfig(
        comfy_dir=tmp_path / "vendor" / "ComfyUI",
        checkpoint=tmp_path / "hy.safetensors",
        bg_model=tmp_path / "bg.safetensors",
        input_dir=tmp_path,
        scratch_dir=tmp_path / "scratch",
    )
    server = ComfyServer(config, ArmState(config, tmp_path, tmp_path).progress)

    with pytest.raises(ChildFailed, match="image-qwen-edit-comfy"):
        server.start()


def test_the_model_search_paths_are_written_for_the_child(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    assert f'checkpoints: "{models}/hy"' in written
    assert f'background_removal: "{models}/bg"' in written

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

from arm_trellis2.generation import JobError
from arm_trellis2.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_trellis2.server import ArmState

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
    for folder in ("trellis", "tex", "bg"):
        (models / folder).mkdir(parents=True, exist_ok=True)
    return FakeConfig(
        comfy_dir=tmp_path,
        diffusion_model=models / "trellis" / "trellis_2_int8_convrot.safetensors",
        clip_vision=models / "trellis" / "dino_v3_vit_l.safetensors",
        shape_vae=models / "trellis" / "trellis_2_shape_vae_bf16.safetensors",
        texture_vae=models / "tex" / "trellis_2_texture_vae_bf16.safetensors",
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
    base = {"jobId": "job-1", "outPath": "2026-10-06/a.glb", "refImages": ["chair.png"]}
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
    assert mesh["textured"] is True
    assert report["vram_scope"] in {"process", "card", "unavailable"}


def test_the_mesh_is_moved_out_of_comfy_s_own_output_tree(arm: ArmState, tmp_path: Path) -> None:
    arm.run(job())
    assert list((tmp_path / "scratch" / "output").rglob("*.glb")) == []


def test_a_batch_writes_one_mesh_per_seed(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(job(batch=3, seed=7, outPath="2026-10-06/b.glb"))

    folder = tmp_path / "outputs" / "2026-10-06"
    assert sorted(path.name for path in folder.iterdir()) == ["b-2.glb", "b-3.glb", "b.glb"]
    assert [mesh["seed"] for mesh in report["meshes"]] == [7, 8, 9]


def test_the_graph_cuts_the_object_out_and_bakes_a_texture(arm: ArmState) -> None:
    arm.run(job(targetFaces=50_000, textureSize=1024, bakeOcclusion=False))

    graph = arm.server.get("/aistudio-test/submitted")["graphs"][-1]
    assert graph["ref"]["inputs"]["image"] == "chair.png"
    assert graph["cond"]["inputs"]["image"] == ["cutout", 0]
    assert graph["decimate"]["inputs"]["target_face_count"] == 50_000
    assert graph["bake"]["inputs"]["texture_size"] == 1024
    assert "normals" in graph and "occlusion" not in graph
    assert graph["save"]["inputs"]["mesh"] == ["final_smooth", 0]


def test_the_timeline_carries_the_child_log(arm: ArmState) -> None:
    arm.run(job())

    snapshot = arm.progress.snapshot()
    steps = {step["key"]: step for step in snapshot["steps"]}
    assert steps["start"]["state"] == "done"
    assert steps["generate"]["state"] == "done"

    children = steps["generate"].get("children", [])
    assert {child["label"] for child in children} >= {"Load image encoder", "Load transformer"}


def test_every_named_node_has_its_own_line_and_each_sampler_its_own_bar(arm: ArmState) -> None:
    arm.run(job(targetFaces=50_000))

    snapshot = arm.progress.snapshot()
    generate = next(step for step in snapshot["steps"] if step["key"] == "generate")
    nodes = {child["label"]: child for child in generate["children"] if child["key"].startswith("node:")}

    assert list(nodes)[:4] == [
        "Cut out the object",
        "Crop to the object",
        "Encode the image (DINOv3)",
        "Sample structure",
    ]
    assert {"Refine shape", "Sample texture", "Remesh", "Decimate", "Unwrap UVs", "Write GLB"} <= set(nodes)
    assert all(node["state"] == "done" for node in nodes.values())
    # The decimator's own line of text, not a step count.
    assert "50K" in nodes["Decimate"]["detail"]
    assert nodes["Sample structure"]["detail"].startswith("12/12")

    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    # One bar per sampler, each full -- never one bar refilled four times.
    samplers = {key: meter for key, meter in meters.items() if key.startswith("progress:")}
    assert set(samplers) == {
        "progress:structure_sampler",
        "progress:shape_sampler",
        "progress:refine_sampler",
        "progress:texture_sampler",
    }
    assert samplers["progress:shape_sampler"]["total"] == 20
    assert all(meter["done"] == meter["total"] for meter in samplers.values())
    assert "steps" not in meters
    assert meters["nodes"]["done"] == meters["nodes"]["total"]


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
    fake = config_for(tmp_path)
    config = LoadConfig(
        comfy_dir=tmp_path / "vendor" / "ComfyUI",
        diffusion_model=fake.diffusion_model,
        clip_vision=fake.clip_vision,
        shape_vae=fake.shape_vae,
        texture_vae=fake.texture_vae,
        bg_model=fake.bg_model,
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
    assert f'diffusion_models: "{models}/trellis"' in written
    assert f'clip_vision: "{models}/trellis"' in written
    assert f'background_removal: "{models}/bg"' in written
    # The VAEs live apart, so the second one gets a section of its own.
    assert f'vae: "{models}/tex"' in written
    assert f'vae: "{models}/trellis"' in written
    assert "aistudio2:" in written

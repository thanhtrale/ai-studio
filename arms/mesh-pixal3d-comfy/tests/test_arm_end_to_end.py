"""The whole arm against a stand-in child.

Everything but the model: the child is started and waited for, its log is read
and turned into a timeline, a graph is built and queued, the GLB, the view
cut-outs and the atlas ComfyUI saved are moved into the library's tree and the
mesh's counts are read back.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from arm_pixal3d.generation import JobError
from arm_pixal3d.runtime import ChildFailed, ComfyServer, LoadConfig
from arm_pixal3d.server import ArmState

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
    for folder in ("pixal3d", "trellis2", "bg", "moge"):
        (models / folder).mkdir(parents=True, exist_ok=True)
    return FakeConfig(
        comfy_dir=tmp_path,
        single_model=models / "pixal3d" / "pixal3d_int8_convrot.safetensors",
        multiview_model=models / "pixal3d" / "pixal3d_multiview_bf16.safetensors",
        clip_vision=models / "pixal3d" / "dino_v3_L_naf_fp32.safetensors",
        shape_vae=models / "trellis2" / "trellis_2_shape_vae_bf16.safetensors",
        texture_vae=models / "trellis2" / "trellis_2_texture_vae_bf16.safetensors",
        bg_model=models / "bg" / "birefnet.safetensors",
        moge_model=models / "moge" / "moge_2_vitl_normal_fp16.safetensors",
        input_dir=tmp_path / "inputs",
        scratch_dir=tmp_path / "scratch",
    )


@pytest.fixture
def arm(tmp_path: Path):
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    for name in ("front", "left", "back"):
        (in_dir / f"{name}.png").write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode())
    state = ArmState(config_for(tmp_path), out_dir, in_dir)
    try:
        yield state
    finally:
        state.shutdown()


SHEET = {"front": "front.png", "left": "left.png", "back": "back.png"}


def job(**overrides: object) -> dict[str, object]:
    base = {"jobId": "job-1", "outPath": "c/r01/mesh.glb", "views": SHEET, "compressTextures": False}
    return {**base, **overrides}


def test_a_multi_view_run_files_the_mesh_its_views_and_its_atlas(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run(job(seed=42))

    folder = tmp_path / "outputs" / "c" / "r01"
    written = folder / "mesh.glb"
    assert written.read_bytes()[:4] == b"glTF"
    assert report["mode"] == "multi-view"
    assert report["model"] == "pixal3d_multiview_bf16.safetensors"

    mesh = report["meshes"][0]
    assert mesh["seed"] == 42
    assert mesh["faces"] == 300_000
    assert mesh["textured"] is True
    assert set(mesh["views"]) == {"front", "left", "back"}
    assert Path(mesh["views"]["back"]) == folder / "mesh_views" / "back.png"
    assert Path(mesh["views"]["back"]).is_file()
    assert Path(mesh["basecolor"]) == folder / "mesh_basecolor.png"
    assert Path(mesh["basecolor"]).is_file()
    # Nothing left behind in ComfyUI's own tree.
    assert [path for path in (tmp_path / "scratch" / "output").rglob("*") if path.is_file()] == []


def test_one_view_runs_the_single_view_model(arm: ArmState) -> None:
    report = arm.run(job(views={"front": "front.png"}))
    assert report["mode"] == "single-view"
    graph = arm.server.get("/aistudio-test/submitted")["graphs"][-1]
    assert graph["unet"]["inputs"]["unet_name"] == "pixal3d_int8_convrot.safetensors"
    assert graph["cond"]["class_type"] == "Pixal3DConditioning"


def test_a_random_seed_is_drawn_per_mesh(arm: ArmState) -> None:
    report = arm.run(job(batch=2, outPath="c/r02/mesh.glb"))
    seeds = [mesh["seed"] for mesh in report["meshes"]]
    assert len(seeds) == 2
    assert all(seed >= 0 for seed in seeds)


def test_the_timeline_names_each_view(arm: ArmState) -> None:
    arm.run(job())
    snapshot = arm.progress.snapshot()
    generate = next(step for step in snapshot["steps"] if step["key"] == "generate")
    labels = [child["label"] for child in generate["children"] if child["key"].startswith("node:")]
    assert labels[:2] == ["Cut out the front view", "Crop the front view"]
    assert {"Encode the views (DINOv3)", "Sample texture", "Write GLB"} <= set(labels)


def test_no_object_found_is_said_in_words(arm: ArmState, tmp_path: Path) -> None:
    (tmp_path / "inputs" / "noobject.png").write_bytes(b"\x89PNG\r\n\x1a\nnothing")
    with pytest.raises(ChildFailed, match="found no object"):
        arm.run(job(views={"front": "noobject.png"}))


def test_a_job_the_arm_rejects_never_opens_a_timeline(arm: ArmState) -> None:
    with pytest.raises(JobError, match=r"views.front is required"):
        arm.run(job(views={"back": "back.png"}))
    assert arm.progress.snapshot() == {"jobId": None, "steps": [], "meters": [], "vram": []}


def test_the_model_search_paths_are_written_for_the_child(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    config.scratch_dir.mkdir(parents=True, exist_ok=True)

    written = config.write_model_paths().read_text(encoding="utf-8")

    models = str(tmp_path / "models").replace("\\", "/")
    assert f'diffusion_models: "{models}/pixal3d"' in written
    assert f'clip_vision: "{models}/pixal3d"' in written
    assert f'vae: "{models}/trellis2"' in written
    assert f'background_removal: "{models}/bg"' in written
    assert f'geometry_estimation: "{models}/moge"' in written


def test_a_missing_checkout_says_what_to_do(tmp_path: Path) -> None:
    fake = config_for(tmp_path)
    config = LoadConfig(
        comfy_dir=tmp_path / "vendor" / "ComfyUI",
        single_model=fake.single_model,
        multiview_model=fake.multiview_model,
        clip_vision=fake.clip_vision,
        shape_vae=fake.shape_vae,
        texture_vae=fake.texture_vae,
        bg_model=fake.bg_model,
        moge_model=fake.moge_model,
        input_dir=tmp_path,
        scratch_dir=tmp_path / "scratch",
    )
    server = ComfyServer(config, ArmState(config, tmp_path, tmp_path).progress)
    with pytest.raises(ChildFailed, match="image-qwen-edit-comfy"):
        server.start()

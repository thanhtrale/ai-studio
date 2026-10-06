"""`parse_job` and the graph, without a child."""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_trellis2.generation import JobError, glb_counts, parse_job, paths_for
from arm_trellis2.graph import Models, Shape, build

from .fake_comfy import tiny_glb

MODELS = Models("t.safetensors", "dino.safetensors", "s.safetensors", "x.safetensors", "bg.safetensors")


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    out_dir, in_dir = tmp_path / "out", tmp_path / "in"
    out_dir.mkdir()
    in_dir.mkdir()
    (in_dir / "a.png").write_bytes(b"x")
    return out_dir, in_dir


def test_defaults_are_the_template_s_with_a_web_sized_output(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "m.glb", "refImages": ["a.png"]}, *dirs)
    assert (job.structure_steps, job.shape_steps, job.refine_steps, job.texture_steps) == (12, 20, 12, 12)
    assert job.steps == 56
    assert (job.cfg_scale, job.shape_resolution) == (7.5, 1024)
    assert (job.target_faces, job.texture_size) == (100_000, 2048)
    assert job.bake_normals and job.bake_occlusion and job.remove_background
    assert job.compress_textures and job.texture_quality == 100


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"outPath": "m.png", "refImages": ["a.png"]}, r"\.glb"),
        ({"outPath": "m.glb", "refImages": []}, "exactly one"),
        ({"outPath": "m.glb", "refImages": ["a.png"], "shapeResolution": 2048}, "one of"),
        ({"outPath": "m.glb", "refImages": ["a.png"], "textureSize": 3000}, "one of"),
        ({"outPath": "m.glb", "refImages": ["a.png"], "targetFaces": 0}, "between"),
        ({"outPath": "m.glb", "refImages": ["a.png"], "bakeNormals": "yes"}, "true or false"),
        ({"outPath": "m.glb", "refImages": ["a.png"], "textureQuality": 0}, "between"),
    ],
)
def test_refusals(dirs: tuple[Path, Path], body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, *dirs)


def test_batch_paths(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "d/m.glb", "refImages": ["a.png"], "batch": 2}, *dirs)
    assert [path.name for path in paths_for(job)] == ["m.glb", "m-2.glb"]


def test_the_four_passes_chain_in_order() -> None:
    graph = build(MODELS, Shape("a.png", 42), "p")
    assert graph["structure_sampler"]["inputs"]["model"] == ["structure_model", 0]
    assert graph["structure_sampler"]["inputs"]["seed"] == 56
    assert graph["shape_sampler"]["inputs"]["latent_image"] == ["shape_stage", 2]
    assert graph["refine_sampler"]["inputs"]["latent_image"] == ["upsample", 2]
    assert graph["refine_sampler"]["inputs"]["scheduler"] == "simple"
    assert graph["texture_sampler"]["inputs"]["model"] == ["unet", 0]
    assert graph["texture_sampler"]["inputs"]["cfg"] == 1.0
    assert graph["texture_decode"]["inputs"]["shape_subdivides"] == ["shape_decode", 1]


def test_without_background_removal_the_alpha_is_the_mask() -> None:
    graph = build(MODELS, Shape("a.png", 1, remove_background=False), "p")
    assert "bg_model" not in graph
    assert graph["mask"]["class_type"] == "InvertMask"
    assert graph["mask"]["inputs"]["mask"] == ["ref", 1]


def test_without_extra_bakes_only_colour_metal_and_roughness_are_applied() -> None:
    graph = build(MODELS, Shape("a.png", 1, bake_normals=False, bake_occlusion=False), "p")
    assert set(graph["apply"]["inputs"]) == {"mesh", "base_color", "metallic", "roughness"}


def test_glb_counts_see_the_texture(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    path.write_bytes(tiny_glb(vertices=10, faces=4, textured=True))
    assert glb_counts(path) == (10, 4, True)
    path.write_bytes(tiny_glb(vertices=10, faces=4))
    assert glb_counts(path) == (10, 4, False)

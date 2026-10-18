"""`parse_job` and the graph, without a child."""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_pixal3d.generation import JobError, glb_counts, parse_job, paths_for
from arm_pixal3d.graph import Models, Shape, build, labels_for

from .fake_comfy import tiny_glb

MODELS = Models(
    "single.safetensors",
    "multi.safetensors",
    "dino.safetensors",
    "s.safetensors",
    "x.safetensors",
    "bg.safetensors",
    "moge.safetensors",
)


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    out_dir, in_dir = tmp_path / "out", tmp_path / "in"
    out_dir.mkdir()
    in_dir.mkdir()
    for name in ("front.png", "left.png", "back.png"):
        (in_dir / name).write_bytes(b"x")
    return out_dir, in_dir


def test_defaults_are_the_character_pipeline_s(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "m.glb", "views": {"front": "front.png"}}, *dirs)
    assert (job.structure_steps, job.shape_steps, job.refine_steps, job.texture_steps) == (12, 20, 12, 12)
    assert job.steps == 56
    assert (job.structure_cfg, job.shape_cfg, job.shape_resolution) == (7.5, 7.5, 1536)
    assert (job.target_faces, job.texture_size, job.fov, job.pad) == (300_000, 2048, 20.0, 1.1)
    assert job.seed == -1
    assert job.bake_normals and job.bake_occlusion
    assert not job.drop_inverted and not job.drop_enclosed
    assert not job.multi


def test_views_keep_the_rig_order_whatever_order_they_arrive_in(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "m.glb", "views": {"back": "back.png", "front": "front.png"}}, *dirs)
    assert list(job.views) == ["front", "back"]
    assert job.multi


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"outPath": "m.png", "views": {"front": "front.png"}}, r"\.glb"),
        ({"outPath": "m.glb"}, "views must map"),
        ({"outPath": "m.glb", "views": {"left": "left.png"}}, "views.front is required"),
        ({"outPath": "m.glb", "views": {"front": "front.png", "top": "back.png"}}, "unknown view top"),
        ({"outPath": "m.glb", "views": {"front": "missing.png"}}, "is not there"),
        ({"outPath": "m.glb", "views": {"front": "../front.png"}}, "outside"),
        ({"outPath": "m.glb", "views": {"front": "front.png"}, "shapeResolution": 2048}, "one of"),
        ({"outPath": "m.glb", "views": {"front": "front.png"}, "targetFaces": 1000}, "between"),
        ({"outPath": "m.glb", "views": {"front": "front.png"}, "bakeNormals": "yes"}, "true or false"),
    ],
)
def test_refusals(dirs: tuple[Path, Path], body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, *dirs)


def test_batch_paths(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "d/m.glb", "views": {"front": "front.png"}, "batch": 2}, *dirs)
    assert [path.name for path in paths_for(job)] == ["m.glb", "m-2.glb"]


def test_one_view_is_conditioned_through_moge_on_the_single_view_model() -> None:
    graph = build(MODELS, Shape({"front": "f.png"}, 42), "p")
    assert graph["unet"]["inputs"]["unet_name"] == "single.safetensors"
    assert graph["cond"]["class_type"] == "Pixal3DConditioning"
    assert graph["cond"]["inputs"]["camera_angle_x"] == ["fov", 0]
    assert graph["moge"]["inputs"]["image"] == ["crop_front", 0]


def test_several_views_go_to_the_multi_view_rig() -> None:
    graph = build(MODELS, Shape({"front": "f.png", "left": "l.png", "back": "b.png"}, 1, fov=20.0), "p")
    assert graph["unet"]["inputs"]["unet_name"] == "multi.safetensors"
    cond = graph["cond"]
    assert cond["class_type"] == "Pixal3DMultiViewConditioning"
    assert cond["inputs"]["front"] == ["crop_front", 0]
    assert cond["inputs"]["left"] == ["crop_left", 0]
    assert cond["inputs"]["back"] == ["crop_back", 0]
    assert "right" not in cond["inputs"]
    assert cond["inputs"]["fov"] == 20.0
    assert "moge" not in graph


def test_every_view_is_cut_out_cropped_at_pad_and_saved() -> None:
    graph = build(MODELS, Shape({"front": "f.png", "back": "b.png"}, 1, pad=1.1), "out/x")
    crop = graph["crop_back"]["inputs"]
    assert crop["masks"] == ["mask_back", 0]
    assert (crop["width"], crop["height"], crop["pad_factor"], crop["background"]) == (
        1024,
        1024,
        1.1,
        "#000000",
    )
    assert graph["save_view_back"]["inputs"]["filename_prefix"] == "out/x/view_back"
    assert graph["save"]["inputs"]["filename_prefix"] == "out/x/mesh"
    assert graph["save_basecolor"]["inputs"]["images"] == ["bake", 0]


def test_the_four_passes_chain_in_order() -> None:
    graph = build(MODELS, Shape({"front": "f.png"}, 42), "p")
    assert graph["structure_sampler"]["inputs"]["model"] == ["structure_model", 0]
    assert graph["structure_sampler"]["inputs"]["seed"] == 56
    assert graph["shape_sampler"]["inputs"]["latent_image"] == ["shape_stage", 2]
    assert graph["upsample"]["inputs"]["target_resolution"] == "1536"
    assert graph["refine_sampler"]["inputs"]["scheduler"] == "simple"
    assert graph["texture_sampler"]["inputs"]["model"] == ["unet", 0]
    assert graph["texture_sampler"]["inputs"]["seed"] == 43
    assert graph["texture_sampler"]["inputs"]["cfg"] == 1.0


def test_the_remesh_carries_the_shell_switches() -> None:
    graph = build(MODELS, Shape({"front": "f.png"}, 1, drop_inverted=True), "p")
    remesh = graph["remesh"]["inputs"]
    assert remesh["mesh"] == ["mesh_info", 0]
    assert remesh["sign_mode.drop_inverted_components"] is True
    assert remesh["sign_mode.drop_enclosed_components"] is False


def test_the_normal_map_is_capped_and_bakes_can_be_left_out() -> None:
    graph = build(MODELS, Shape({"front": "f.png"}, 1, texture_size=4096), "p")
    assert graph["normals"]["inputs"]["resolution"] == 2048
    graph = build(MODELS, Shape({"front": "f.png"}, 1, bake_normals=False, bake_occlusion=False), "p")
    assert set(graph["apply"]["inputs"]) == {"mesh", "base_color", "metallic", "roughness"}


def test_labels_name_each_view() -> None:
    labels = labels_for(build(MODELS, Shape({"front": "f.png", "left": "l.png"}, 1), "p"))
    assert labels["mask_left"] == "Cut out the left view"
    assert labels["cond"] == "Encode the views (DINOv3)"
    assert "moge" not in labels


def test_glb_counts_see_the_texture(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    path.write_bytes(tiny_glb(vertices=10, faces=4, textured=True))
    assert glb_counts(path) == (10, 4, True)

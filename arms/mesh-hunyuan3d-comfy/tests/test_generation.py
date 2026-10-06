"""`parse_job` and the graph, without a child."""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_hy3d import graph as graph_module
from arm_hy3d.generation import JobError, glb_counts, parse_job, paths_for
from arm_hy3d.graph import Models, Shape, build

from .fake_comfy import tiny_glb


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    out_dir, in_dir = tmp_path / "out", tmp_path / "in"
    out_dir.mkdir()
    in_dir.mkdir()
    (in_dir / "sub").mkdir()
    (in_dir / "sub" / "a.png").write_bytes(b"x")
    return out_dir, in_dir


def test_defaults_are_the_blueprint_s(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "m.glb", "refImages": ["sub/a.png"]}, *dirs)
    assert job.reference == "sub/a.png"
    assert (job.steps, job.cfg_scale, job.octree, job.latent_tokens) == (30, 5.0, 256, 4096)
    assert job.target_faces == 0
    assert job.remove_background is True


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"outPath": "m.png", "refImages": ["sub/a.png"]}, r"\.glb"),
        ({"outPath": "../m.glb", "refImages": ["sub/a.png"]}, "outside"),
        ({"outPath": "m.glb", "refImages": ["../x.png"]}, "outside"),
        ({"outPath": "m.glb", "refImages": ["sub/a.png", "sub/a.png"]}, "exactly one"),
        ({"outPath": "m.glb", "refImages": ["sub/missing.png"]}, "not there"),
        ({"outPath": "m.glb", "refImages": ["sub/a.png"], "octreeResolution": 300}, "one of"),
        ({"outPath": "m.glb", "refImages": ["sub/a.png"], "targetFaces": -1}, "between"),
        ({"outPath": "m.glb", "refImages": ["sub/a.png"], "removeBackground": "yes"}, "true or false"),
    ],
)
def test_refusals(dirs: tuple[Path, Path], body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, *dirs)


def test_batch_paths_follow_the_image_arm(dirs: tuple[Path, Path]) -> None:
    job = parse_job({"outPath": "d/m.glb", "refImages": ["sub/a.png"], "batch": 3}, *dirs)
    assert [path.name for path in paths_for(job)] == ["m.glb", "m-2.glb", "m-3.glb"]


def test_without_background_removal_the_photo_goes_straight_in() -> None:
    graph = build(Models("hy.safetensors", "bg.safetensors"), Shape("a.png", 1, remove_background=False), "p")
    assert "mask" not in graph and "cutout" not in graph
    assert graph["vision"]["inputs"]["image"] == ["ref", 0]


def test_no_decimation_saves_the_raw_surface() -> None:
    graph = build(Models("hy.safetensors", "bg.safetensors"), Shape("a.png", 1), "p")
    assert graph_module.DECIMATE not in graph
    assert graph["save"]["inputs"]["mesh"] == ["orient", 0]
    assert graph["orient"]["inputs"]["mode.angle_y"] == -90.0
    assert graph["shift"]["inputs"]["shift"] == 1.0


def test_glb_counts(tmp_path: Path) -> None:
    path = tmp_path / "m.glb"
    path.write_bytes(tiny_glb(vertices=10, faces=4))
    assert glb_counts(path) == (10, 4)

    path.write_bytes(b"not a glb at all, no")
    assert glb_counts(path) == (None, None)

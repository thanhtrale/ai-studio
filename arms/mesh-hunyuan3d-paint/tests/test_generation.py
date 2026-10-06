"""Job validation: what the route may send, and what it may not."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("trimesh")

from arm_hy3dpaint.generation import JobError, parse_job, paths_for, seeds_for


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    out_dir = tmp_path / "outputs"
    in_dir = tmp_path / "inputs"
    out_dir.mkdir()
    in_dir.mkdir()
    (in_dir / "chair.png").write_bytes(b"png")
    (in_dir / "chair.glb").write_bytes(b"glTF")
    return out_dir, in_dir


def body(**extra: object) -> dict:
    return {"outPath": "mesh/chair.glb", "refImages": ["chair.png"], **extra}


def test_defaults(roots: tuple[Path, Path]) -> None:
    job = parse_job(body(), *roots)
    assert job.texture and job.upscale and job.compress_textures
    assert (job.steps, job.cfg_scale, job.octree, job.target_faces) == (30, 5.0, 256, 40_000)
    assert (job.paint_views, job.paint_resolution, job.paint_steps, job.texture_size) == (6, 512, 15, 2048)
    assert job.mesh_path is None


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"outPath": "../escape.glb"}, "outside"),
        ({"outPath": "mesh/chair.obj"}, ".glb"),
        ({"refImages": []}, "exactly one"),
        ({"refImages": ["a.png", "b.png"]}, "exactly one"),
        ({"refImages": ["missing.png"]}, "not there"),
        ({"paintViews": 5}, "paintViews"),
        ({"paintResolution": 640}, "paintResolution"),
        ({"textureSize": 512}, "textureSize"),
        ({"targetFaces": 100}, "targetFaces"),
        ({"texture": "yes"}, "texture"),
        ({"meshPath": "../x.glb"}, "outside"),
        ({"meshPath": "chair.png"}, "GLB"),
        ({"meshPath": "chair.glb", "texture": False}, "only copy"),
        ({"meshPath": "chair.glb", "batch": 2}, "batch"),
    ],
)
def test_rejects(roots: tuple[Path, Path], extra: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body(**extra), *roots)


def test_mesh_path(roots: tuple[Path, Path]) -> None:
    job = parse_job(body(meshPath="chair.glb"), *roots)
    assert job.mesh_path == (roots[1] / "chair.glb").resolve()


def test_batch_names_and_seeds(roots: tuple[Path, Path]) -> None:
    job = parse_job(body(batch=3, seed=7), *roots)
    assert seeds_for(job) == [7, 8, 9]
    assert [path.name for path in paths_for(job)] == ["chair.glb", "chair-2.glb", "chair-3.glb"]

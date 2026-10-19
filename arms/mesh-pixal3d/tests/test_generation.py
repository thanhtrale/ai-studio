from pathlib import Path

import pytest

from arm_pixal3d.generation import JobError, parse_job


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    out, inp = tmp_path / "out", tmp_path / "in"
    out.mkdir()
    inp.mkdir()
    (inp / "a.png").write_bytes(b"x")
    return out, inp


def test_defaults(roots):
    job = parse_job({"refImages": ["a.png"], "outPath": "m.glb", "seed": 7}, *roots)
    assert job.params.seed == 7
    assert job.params.resolution == 1024
    assert job.params.target_faces == 150_000


def test_one_image_only(roots):
    with pytest.raises(JobError, match="exactly one"):
        parse_job({"refImages": ["a.png", "a.png"], "outPath": "m.glb"}, *roots)


def test_paths_confined(roots):
    with pytest.raises(JobError, match="outside"):
        parse_job({"refImages": ["../x.png"], "outPath": "m.glb"}, *roots)
    with pytest.raises(JobError, match=r".glb"):
        parse_job({"refImages": ["a.png"], "outPath": "m.obj"}, *roots)


def test_resolution_choices(roots):
    with pytest.raises(JobError, match="resolution"):
        parse_job({"refImages": ["a.png"], "outPath": "m.glb", "resolution": 2048}, *roots)

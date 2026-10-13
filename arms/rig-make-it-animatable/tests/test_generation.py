"""Job validation, and the clip list the arm reports."""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_mia.builtin_clips import BUILTIN
from arm_mia.generation import JobError, available_clips, clip_name, parse_job


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path, Path]:
    out_dir, in_dir, clip_dir = tmp_path / "outputs", tmp_path / "inputs", tmp_path / "clips"
    for path in (out_dir, in_dir, clip_dir):
        path.mkdir()
    (in_dir / "hero.glb").write_bytes(b"glTF")
    (clip_dir / "Samba Dancing.fbx").write_bytes(b"fbx")
    (clip_dir / "bad;name.fbx").write_bytes(b"fbx")
    return out_dir, in_dir, clip_dir


def body(**extra: object) -> dict:
    return {"outPath": "rig/hero.glb", "meshPath": "hero.glb", **extra}


def test_defaults(roots: tuple[Path, Path, Path]) -> None:
    job = parse_job(body(), *roots)
    assert job.clips == [] and job.remove_fingers and job.inplace and job.compress_textures


def test_clips_mix_builtin_and_files(roots: tuple[Path, Path, Path]) -> None:
    job = parse_job(body(clips=["Idle", "Samba Dancing", "Idle"]), *roots)
    assert job.clips[0] == "builtin:Idle"
    assert Path(job.clips[1]).name == "Samba Dancing.fbx"
    assert len(job.clips) == 2
    assert [clip_name(c) for c in job.clips] == ["Idle", "Samba Dancing"]


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"outPath": "../x.glb"}, "outside"),
        ({"outPath": "rig/hero.fbx"}, ".glb"),
        ({"meshPath": "missing.glb"}, "exists"),
        ({"meshPath": "../hero.glb"}, "outside"),
        ({"clips": "Idle"}, "list"),
        ({"clips": ["Moonwalk"]}, "neither"),
        ({"clips": ["../../etc"]}, "not a clip name"),
        ({"removeFingers": "yes"}, "removeFingers"),
        ({"textureQuality": 0}, "textureQuality"),
    ],
)
def test_rejects(roots: tuple[Path, Path, Path], extra: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body(**extra), *roots)


def test_available_clips_skips_unsafe_names(roots: tuple[Path, Path, Path]) -> None:
    assert available_clips(roots[2]) == ["Samba Dancing"]


def test_builtin_clips_are_well_formed() -> None:
    for name, make in BUILTIN.items():
        keys = make()
        frames = [frame for frame, _ in keys]
        assert frames == sorted(frames) and frames[0] == 0, name
        for _, pose in keys:
            for bone, turns in pose.items():
                assert bone[0].isupper() and ":" not in bone
                for axis, degrees in turns:
                    assert len(axis) == 3 and abs(degrees) <= 90


def test_a_draft_needs_a_mesh_and_a_draft_folder_but_no_output(roots: tuple[Path, Path, Path]) -> None:
    job = parse_job({"mode": "draft", "meshPath": "hero.glb", "draftDir": ".rig-drafts/abcdefgh12"}, *roots)
    assert job.mode == "draft" and job.out_path is None and job.clips == []
    assert job.draft_dir == (roots[0] / ".rig-drafts" / "abcdefgh12").resolve()


def test_a_bind_needs_a_draft_that_exists(roots: tuple[Path, Path, Path]) -> None:
    draft = {"mode": "bind", "outPath": "rig/hero.glb", "draftDir": ".rig-drafts/abcdefgh12"}
    with pytest.raises(JobError, match="not a draft"):
        parse_job(draft, *roots)
    (roots[0] / ".rig-drafts" / "abcdefgh12").mkdir(parents=True)
    (roots[0] / ".rig-drafts" / "abcdefgh12" / "rig.npz").write_bytes(b"npz")
    bones = {"mixamorig:Hips": {"head": [0, 0, 0], "tail": [0, 1, 0]}}
    job = parse_job({**draft, "clips": ["Idle"], "bones": bones}, *roots)
    assert job.mesh_path is None and job.bones == bones and job.clips == ["builtin:Idle"]


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"mode": "nope"}, "mode"),
        ({"mode": "draft", "draftDir": "elsewhere/abcdefgh12"}, "draftDir"),
        ({"mode": "draft", "draftDir": ".rig-drafts/../../x"}, "draftDir"),
        ({"mode": "draft", "draftDir": ".rig-drafts/short"}, "draftDir"),
        ({"bones": {}}, "only for mode bind"),
    ],
)
def test_rejects_bad_modes(roots: tuple[Path, Path, Path], extra: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body(**extra), *roots)

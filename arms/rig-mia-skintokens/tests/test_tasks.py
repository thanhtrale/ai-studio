"""Job validation: what reaches a script, and what never does."""

from __future__ import annotations

from pathlib import Path

import pytest

from arm_mia_st.tasks import JobError, Roots, parse_job


@pytest.fixture
def roots(tmp_path: Path) -> Roots:
    inputs, outputs, models = tmp_path / "inputs", tmp_path / "outputs", tmp_path / "models"
    for folder in (inputs / "c" / "r01", outputs, models / "rig" / "mixamo" / "animation"):
        folder.mkdir(parents=True)
    (inputs / "c" / "r01" / "mesh.glb").write_bytes(b"glTF")
    (inputs / "c" / "r01" / "front.png").write_bytes(b"png")
    (inputs / "c" / "r01" / "sheet_0.png").write_bytes(b"png")
    (inputs / "c" / "r01" / "mia_raw.pkl").write_bytes(b"pkl")
    (models / "rig" / "mixamo" / "animation" / "walk.fbx").write_bytes(b"fbx")
    return Roots(inputs, outputs, models)


def rig(**overrides: object) -> dict[str, object]:
    return {"task": "rig", "meshPath": "c/r01/mesh.glb", "outDir": "c/r02/rig", **overrides}


def test_a_rig_gets_absolute_paths_and_the_pipeline_s_defaults(roots: Roots) -> None:
    job = parse_job(rig(animations=[{"name": "Walk", "path": "rig/mixamo/animation/walk.fbx"}]), "rig", roots)
    assert job.script == "rig.py"
    payload = job.payload
    assert payload["mesh"] == str((roots.inputs / "c" / "r01" / "mesh.glb").resolve())
    assert payload["out"] == str((roots.outputs / "c" / "r02" / "rig").resolve())
    assert payload["animations"] == [
        {"name": "Walk", "path": str((roots.models / "rig" / "mixamo" / "animation" / "walk.fbx").resolve())}
    ]
    assert payload["modelsRoot"] == str(roots.models.resolve())
    assert (payload["restPose"], payload["noFingers"]) == ("A-pose", True)


def test_rig_options_pass_through_and_may_override_the_defaults(roots: Roots) -> None:
    options = {"restPose": "T-pose", "weights": "heat", "armSpace": 45, "prep": {"hairCut": False}, "seed": 3}
    payload = parse_job(rig(options=options, predFrom="c/r01/mia_raw.pkl"), "rig", roots).payload
    assert payload["restPose"] == "T-pose"
    assert payload["weights"] == "heat"
    assert payload["prep"] == {"hairCut": False}
    assert payload["predFrom"].endswith("mia_raw.pkl")


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (rig(meshPath="../escape.glb"), "outside"),
        (rig(meshPath="C:/x/mesh.glb"), "relative"),
        (rig(meshPath="c/r01/front.png"), r"\.glb"),
        (rig(meshPath="c/r01/missing.glb"), "is not there"),
        (rig(options={"weightz": "heat"}), "unknown option weightz"),
        (rig(options={"weights": "magic"}), "weights must be one of"),
        (rig(options={"restPose": "Y-pose"}), "restPose"),
        (rig(options={"armSpace": True}), "must not be true or false"),
        (rig(options={"prep": {"voxels": 1}}), "unknown prep option voxels"),
        (rig(animations=[{"name": "Walk", "path": "../walk.fbx"}]), "outside"),
        (rig(animations=[{"path": "rig/mixamo/animation/walk.fbx"}]), "needs a name"),
        (rig(skinFrom="c/r01/mia_raw.pkl"), r"\.npz"),
        ({"task": "fly"}, "task must be one of"),
    ],
)
def test_refusals(roots: Roots, body: dict, message: str) -> None:
    with pytest.raises(JobError, match=message):
        parse_job(body, "rig", roots)


def test_each_role_serves_only_its_own_tasks(roots: Roots) -> None:
    with pytest.raises(JobError, match="served by this arm's tools role"):
        parse_job({"task": "render", "glb": "c/r01/mesh.glb", "outDir": "r"}, "rig", roots)
    with pytest.raises(JobError, match="served by this arm's rig role"):
        parse_job(rig(), "tools", roots)


def test_split_render_and_reproject(roots: Roots) -> None:
    split = parse_job(
        {"task": "split", "sheets": ["c/r01/sheet_0.png"], "outDir": "c/r01/ref"}, "tools", roots
    )
    assert split.payload["sheets"] == [str((roots.inputs / "c" / "r01" / "sheet_0.png").resolve())]

    render = parse_job(
        {
            "task": "render",
            "glb": "c/r01/mesh.glb",
            "outDir": "c/r01/renders",
            "mode": "anim",
            "options": {"frames": 8, "res": 512},
        },
        "tools",
        roots,
    )
    assert (render.payload["mode"], render.payload["frames"], render.payload["res"]) == ("anim", 8, 512)

    reproject = parse_job(
        {
            "task": "reproject",
            "glb": "c/r01/mesh.glb",
            "outPath": "c/r01/out.glb",
            "views": {"front": "c/r01/front.png"},
            "options": {"hairChroma": 0.25},
        },
        "tools",
        roots,
    )
    assert reproject.payload["out"].endswith("out.glb")
    assert reproject.payload["hairChroma"] == 0.25
    assert list(reproject.payload["views"]) == ["front"]


def test_a_render_mode_is_one_of_two(roots: Roots) -> None:
    with pytest.raises(JobError, match="mode must be one of"):
        parse_job({"task": "render", "glb": "c/r01/mesh.glb", "outDir": "r", "mode": "movie"}, "tools", roots)

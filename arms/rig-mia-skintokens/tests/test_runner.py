"""A script run, end to end, against stand-in scripts that speak the real protocol."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from arm_mia_st.runner import ScriptFailed
from arm_mia_st.server import ArmState
from arm_mia_st.tasks import Roots

FAKE_RIG = """
import json, sys, time
from pathlib import Path
_out = sys.stdout
sys.stdout = sys.stderr
job = json.loads(sys.stdin.read())
def emit(event, **kw):
    _out.write(json.dumps({"event": event, "ms": 0, **kw}) + "\\n"); _out.flush()
print("loading MIA from", __import__("os").environ.get("MIA_DIR"))
if "boom" in job["mesh"]:
    emit("error", message="the network said no")
    sys.exit(1)
if "silent" in job["mesh"]:
    sys.exit(3)
out = Path(job["out"]); out.mkdir(parents=True, exist_ok=True)
for stage in ("prep", "mia", "skintokens", "bind"):
    emit("stage", stage=stage)
    time.sleep(0.01)
emit("step", stage="clips", i=1, of=2)
emit("step", stage="clips", i=2, of=2)
(out / "rigged.glb").write_bytes(b"glTF")
clips = [{"name": c["name"]} for c in job["animations"]]
emit("done", path=str(out / "rigged.glb"), rest=str(out / "rest.glb"), clips=clips,
     bones=22, peakVramMiB=8600, phaseMs={"mia": 1000})
"""


@pytest.fixture
def arm(tmp_path: Path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "rig.py").write_text(FAKE_RIG, encoding="utf-8")
    roots = Roots(tmp_path / "inputs", tmp_path / "outputs", tmp_path / "models")
    for root in (roots.inputs / "c", roots.outputs, roots.models):
        root.mkdir(parents=True, exist_ok=True)
    for name in ("mesh.glb", "boom.glb", "silent.glb"):
        (roots.inputs / "c" / name).write_bytes(b"glTF")
    state = ArmState("rig", roots, {"MIA_DIR": "vendor/mia"}, scripts, Path(sys.executable))
    yield state
    state.shutdown()


def test_a_rig_reports_the_script_s_result_and_its_stages(arm: ArmState, tmp_path: Path) -> None:
    report = arm.run({"jobId": "job-1", "task": "rig", "meshPath": "c/mesh.glb", "outDir": "c/r02/rig"})

    assert report["task"] == "rig"
    result = report["result"]
    assert Path(result["path"]) == (tmp_path / "outputs" / "c" / "r02" / "rig" / "rigged.glb").resolve()
    assert Path(result["path"]).is_file()
    assert result["bones"] == 22
    assert [stage["name"] for stage in report["stages"]] == ["prep", "mia", "skintokens", "bind"]


def test_the_timeline_nests_each_stage_under_the_task(arm: ArmState) -> None:
    arm.run({"jobId": "job-2", "task": "rig", "meshPath": "c/mesh.glb", "outDir": "c/r03/rig"})
    snapshot = arm.progress.snapshot()
    assert snapshot["jobId"] == "job-2"
    task = next(step for step in snapshot["steps"] if step["key"] == "task:rig")
    assert task["state"] == "done"
    assert [child["label"] for child in task["children"]] == ["prep", "mia", "skintokens", "bind"]
    meters = {meter["key"]: meter for meter in snapshot["meters"]}
    assert (meters["rig:clips"]["done"], meters["rig:clips"]["total"]) == (2, 2)


def test_a_script_error_is_the_job_s_error_with_its_log(arm: ArmState) -> None:
    with pytest.raises(ScriptFailed, match="the network said no"):
        arm.run({"jobId": "job-3", "task": "rig", "meshPath": "c/boom.glb", "outDir": "c/r04/rig"})
    failed = {step["key"] for step in arm.progress.snapshot()["steps"] if step["state"] == "failed"}
    assert failed


def test_a_script_that_dies_without_a_result_says_so(arm: ArmState) -> None:
    with pytest.raises(ScriptFailed, match="exited with code 3 and no result"):
        arm.run({"jobId": "job-4", "task": "rig", "meshPath": "c/silent.glb", "outDir": "c/r05/rig"})


def test_the_environment_reaches_the_script(arm: ArmState) -> None:
    with pytest.raises(ScriptFailed) as failure:
        arm.run({"jobId": "job-5", "task": "rig", "meshPath": "c/boom.glb", "outDir": "c/r06/rig"})
    # The stderr tail carries the script's own log line.
    assert "loading MIA from vendor/mia" in str(failure.value)

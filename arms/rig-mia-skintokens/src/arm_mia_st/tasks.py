"""The four things this arm can be asked to do, and how each becomes a script run.

The work itself is in `scripts/`, vendored from companion-web where every
constant in it was measured: `rig.py` (Make-It-Animatable v2 joints, SkinTokens
weights, Blender bind and clips), `render.py` (Workbench check renders and the
stretch and hand-in-body measures), `reproject.py` (the input views' colours
projected back onto a Pixal3D atlas), `hairfix.py` (Pixal3D's shredded hair
cards fused into solid locks), `facefix.py` (a chibi muzzle flattened, ears smaller) and
`split_sheet.py` (a three-view sheet
cut into views and cross-checked). Each reads one JSON job and writes JSON lines
on stdout -- `stage`, `step`, then `done` or `error` -- and that protocol is
what this module translates.

A script runs in a process of its own, per job, for the reason the ai-studio
Make-It-Animatable arm gives for its Blender step: `bpy` holds global state,
wants the main thread, and faults at interpreter exit on this build. A child
that crashes after writing its result costs nothing here.

What this module owns is where a file may be read from and written to. Every
path in a job is relative -- inputs to `inputDir`, outputs to `outputDir`,
clips to the models directory -- and is turned into an absolute path here,
after it has been proven to stay inside its root. The scripts only ever see
paths this module built.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Which role serves which task. `rig` holds the card; the tools are CPU work
#: (Blender Workbench draws a few hundred MiB) and run on an arm that declares
#: no GPU, so a render after a mesh never evicts the mesh arm.
ROLE_TASKS: dict[str, tuple[str, ...]] = {
    "rig": ("rig",),
    "tools": ("split", "reproject", "hairfix", "facefix", "render"),
}

SCRIPTS: dict[str, str] = {
    "rig": "rig.py",
    "split": "split_sheet.py",
    "reproject": "reproject.py",
    "hairfix": "hairfix.py",
    "facefix": "facefix.py",
    "render": "render.py",
}

#: What the timeline calls each task's own step.
TASK_LABELS: dict[str, str] = {
    "rig": "Rig",
    "split": "Split sheets",
    "reproject": "Re-project colours",
    "hairfix": "Fuse hair",
    "facefix": "Flatten the muzzle",
    "render": "Render checks",
}

MAX_SHEETS = 8
MAX_CLIPS = 64
VIEW_NAMES = ("front", "left", "back", "right")

#: `rig.py`'s own switches, passed through as they are -- its docstring is the
#: reference for each, and its defaults are the measured ones. Anything else is
#: refused so a typo cannot silently fall back to a default.
RIG_OPTIONS: dict[str, tuple[type, ...]] = {
    "restPose": (str, type(None)),
    "noFingers": (bool,),
    "retarget": (bool,),
    "inplace": (bool,),
    "weightFix": (bool,),
    "headTarget": (int, float),
    "seed": (int,),
    "prep": (bool, dict),
    "weights": (str,),
    "armSmooth": (int,),
    "legSmooth": (int,),
    "rigidHand": (bool,),
    "armSpace": (int, float),
    "torsoClear": (bool,),
    "kneeRaise": (int, float),
    "elbowFix": (bool, int, float, dict),
    "sleeveSkinFix": (bool, int, float),
    "faceFromRef": (bool,),
    "canonical": (bool,),
    "clothFix": (bool, dict),
    "capeBack": (bool, int, float, dict),
    "rigidHead": (bool, dict),
}
REST_POSES = ("A-pose", "T-pose", None)
WEIGHT_MODES = ("skintokens", "heat", "mia")
PREP_OPTIONS = {"voxel", "faces", "minPart", "hairCut", "texture"}

REPROJECT_OPTIONS: dict[str, tuple[type, ...]] = {
    "flow": (bool,),
    "hairChroma": (int, float),
    "hairLum": (int, float),
    "lumMix": (int, float),
}
HAIRFIX_OPTIONS: dict[str, tuple[type, ...]] = {
    "dilate": (int, float),
    "erode": (int, float),
    "voxel": (int, float),
    "smooth": (int,),
    "lumMax": (int, float),
    "fringeDepth": (int, float),
    "fringeFront": (int, float),
    "fringeWidth": (int, float),
    "roughness": (int, float),
}
FACEFIX_OPTIONS: dict[str, tuple[type, ...]] = {
    "half": (int, float),
    "eyeAbove": (int, float),
    "flatten": (int,),
    "ears": (int, float),
    "earX": (int, float),
}
RENDER_MODES = ("turntable", "anim")
RENDER_OPTIONS: dict[str, tuple[type, ...]] = {
    "res": (int,),
    "frames": (int,),
    "faceFromTop": (int, float),
    "faceScale": (int, float),
}


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Roots:
    """The three directories a job's paths are confined to."""

    inputs: Path
    outputs: Path
    models: Path


@dataclass
class ScriptJob:
    """One script run: which script, and the JSON it is given."""

    task: str
    script: str
    payload: dict[str, Any]
    #: Where the script writes, so a failure can say what it left behind.
    out_dir: Path
    #: Shown on the timeline next to the task's label.
    detail: str
    #: Extra environment the script needs (SkinTokens' interpreter, MIA's checkout).
    env: dict[str, str] = field(default_factory=dict)


def _inside(root: Path, candidate: object, what: str) -> Path:
    """A job-supplied relative path, resolved and proven to be under `root`."""
    if not isinstance(candidate, str) or not candidate or "\x00" in candidate:
        raise JobError(f"{what} is required and must be a path")
    if Path(candidate).is_absolute() or re.match(r"^[A-Za-z]:", candidate):
        raise JobError(f"{what} must be relative, not {candidate}")
    resolved = (root / candidate).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise JobError(f"{what} resolves outside {root_resolved}")
    return resolved


def _existing(root: Path, candidate: object, what: str, suffixes: tuple[str, ...]) -> Path:
    path = _inside(root, candidate, what)
    if path.suffix.lower() not in suffixes:
        raise JobError(f"{what} must be a {' or '.join(suffixes)} file")
    if not path.is_file():
        raise JobError(f"{what} ({candidate}) is not there")
    return path


def _options(body: dict[str, Any], allowed: dict[str, tuple[type, ...]]) -> dict[str, Any]:
    raw = body.get("options") or {}
    if not isinstance(raw, dict):
        raise JobError("options must be an object")
    unknown = sorted(set(raw) - set(allowed))
    if unknown:
        raise JobError(f"unknown option {', '.join(unknown)}")
    for key, value in raw.items():
        kinds = allowed[key]
        # bool is an int in Python; an int option given true is a mistake.
        if isinstance(value, bool) and bool not in kinds:
            raise JobError(f"options.{key} must not be true or false")
        if not isinstance(value, kinds):
            raise JobError(f"options.{key} has the wrong type")
    return dict(raw)


def _rig(body: dict[str, Any], roots: Roots) -> ScriptJob:
    mesh = _existing(roots.inputs, body.get("meshPath"), "meshPath", (".glb",))
    out_dir = _inside(roots.outputs, body.get("outDir"), "outDir")

    options = _options(body, RIG_OPTIONS)
    if options.get("restPose", "A-pose") not in REST_POSES:
        raise JobError("options.restPose must be A-pose, T-pose or null")
    if options.get("weights", "skintokens") not in WEIGHT_MODES:
        raise JobError(f"options.weights must be one of {', '.join(WEIGHT_MODES)}")
    prep = options.get("prep")
    if isinstance(prep, dict):
        unknown = sorted(set(prep) - PREP_OPTIONS)
        if unknown:
            raise JobError(f"unknown prep option {', '.join(unknown)}")

    raw_clips = body.get("animations") or []
    if not isinstance(raw_clips, list) or len(raw_clips) > MAX_CLIPS:
        raise JobError(f"animations must be a list of at most {MAX_CLIPS} clips")
    clips = []
    for index, clip in enumerate(raw_clips):
        if not isinstance(clip, dict) or not isinstance(clip.get("name"), str) or not clip["name"]:
            raise JobError(f"animations[{index}] needs a name")
        clips.append(
            {
                "name": clip["name"],
                "path": str(
                    _existing(roots.models, clip.get("path"), f"animations[{index}].path", (".fbx",))
                ),
            }
        )

    payload: dict[str, Any] = {
        # The character pipeline's defaults, which rig.py itself leaves to its caller.
        "restPose": "A-pose",
        "noFingers": True,
        **options,
        "mesh": str(mesh),
        "out": str(out_dir),
        "animations": clips,
        "modelsRoot": str(roots.models.resolve()),
    }
    # A previous run's raw prediction and SkinTokens weights, reused so two
    # fixes can be compared on the same sample: neither model is deterministic.
    for key in ("predFrom", "skinFrom"):
        if body.get(key) is not None:
            suffix = (".pkl",) if key == "predFrom" else (".npz",)
            payload[key] = str(_existing(roots.inputs, body[key], key, suffix))

    detail = f"{payload['restPose'] or 'no rest pose'} · weights {payload.get('weights', 'skintokens')}"
    detail += f" · {len(clips)} clip{'' if len(clips) == 1 else 's'}"
    return ScriptJob("rig", SCRIPTS["rig"], payload, out_dir, detail)


def _split(body: dict[str, Any], roots: Roots) -> ScriptJob:
    raw = body.get("sheets")
    if not isinstance(raw, list) or not raw or len(raw) > MAX_SHEETS:
        raise JobError(f"sheets must list between 1 and {MAX_SHEETS} images")
    sheets = [str(_existing(roots.inputs, entry, f"sheets[{i}]", (".png",))) for i, entry in enumerate(raw)]
    out_dir = _inside(roots.outputs, body.get("outDir"), "outDir")
    payload = {"sheets": sheets, "outDir": str(out_dir)}
    return ScriptJob(
        "split", SCRIPTS["split"], payload, out_dir, f"{len(sheets)} sheet{'' if len(sheets) == 1 else 's'}"
    )


def _reproject(body: dict[str, Any], roots: Roots) -> ScriptJob:
    glb = _existing(roots.inputs, body.get("glb"), "glb", (".glb",))
    out = _inside(roots.outputs, body.get("outPath"), "outPath")
    if out.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")

    raw = body.get("views")
    if not isinstance(raw, dict) or not raw:
        raise JobError("views must map a view name to the cut-out the mesh was made from")
    unknown = sorted(set(raw) - set(VIEW_NAMES))
    if unknown:
        raise JobError(f"unknown view {', '.join(unknown)}")
    # The rig's order, so the script meets the views as Pixal3D's camera rig does.
    views = {
        name: str(_existing(roots.inputs, raw[name], f"views.{name}", (".png",)))
        for name in VIEW_NAMES
        if name in raw
    }
    payload = {**_options(body, REPROJECT_OPTIONS), "glb": str(glb), "out": str(out), "views": views}
    return ScriptJob("reproject", SCRIPTS["reproject"], payload, out.parent, f"from {', '.join(views)}")


def _hairfix(body: dict[str, Any], roots: Roots) -> ScriptJob:
    glb = _existing(roots.inputs, body.get("glb"), "glb", (".glb",))
    out = _inside(roots.outputs, body.get("outPath"), "outPath")
    if out.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")
    payload = {**_options(body, HAIRFIX_OPTIONS), "glb": str(glb), "out": str(out)}
    return ScriptJob("hairfix", SCRIPTS["hairfix"], payload, out.parent, "fuse hair cards")


def _facefix(body: dict[str, Any], roots: Roots) -> ScriptJob:
    glb = _existing(roots.inputs, body.get("glb"), "glb", (".glb",))
    out = _inside(roots.outputs, body.get("outPath"), "outPath")
    if out.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")
    payload = {**_options(body, FACEFIX_OPTIONS), "glb": str(glb), "out": str(out)}
    return ScriptJob("facefix", SCRIPTS["facefix"], payload, out.parent, "flatten the muzzle, smaller ears")


def _render(body: dict[str, Any], roots: Roots) -> ScriptJob:
    glb = _existing(roots.inputs, body.get("glb"), "glb", (".glb",))
    out_dir = _inside(roots.outputs, body.get("outDir"), "outDir")
    mode = body.get("mode", "turntable")
    if mode not in RENDER_MODES:
        raise JobError(f"mode must be one of {', '.join(RENDER_MODES)}")
    payload = {**_options(body, RENDER_OPTIONS), "glb": str(glb), "out": str(out_dir), "mode": mode}
    return ScriptJob("render", SCRIPTS["render"], payload, out_dir, mode)


PARSERS = {
    "rig": _rig,
    "split": _split,
    "reproject": _reproject,
    "hairfix": _hairfix,
    "facefix": _facefix,
    "render": _render,
}


def parse_job(body: dict[str, Any], role: str, roots: Roots) -> ScriptJob:
    task = body.get("task")
    served = ROLE_TASKS[role]
    if task not in PARSERS:
        raise JobError(f"task must be one of {', '.join(served)}")
    if task not in served:
        other = next(name for name, tasks in ROLE_TASKS.items() if task in tasks)
        raise JobError(f"task {task} is served by this arm's {other} role, not by {role}")
    return PARSERS[task](body, roots)

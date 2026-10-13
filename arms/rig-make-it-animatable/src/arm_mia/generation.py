"""One rig job: validate it, predict the rig, hand it to Blender, file the GLB.

The input is a mesh the studio already has -- staged under `inputDir` by the
route, as reference images are -- and the output is that mesh with a Mixamo
skeleton, skin weights and the chosen clips, one GLB three.js plays with an
`AnimationMixer`.

Three modes, by the job's `mode`:

- `rig` (the default): predict and bind in one go.
- `draft`: predict only, and write the rig for review under
  `outputDir/.rig-drafts/<id>/` (see `rigdata`). The library skips dot
  folders, so a draft is never mistaken for a result.
- `bind`: bind a draft, with whatever the person changed -- bones moved in the
  job's `bones`, weights repainted in the draft's `weights.edited.bin`.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import rigdata
from .builtin_clips import BUILTIN
from .engine import Engine
from .progress import JobProgress
from .webp import compress_textures, decompress_textures

#: A clip name is a file name in the clip folder, without `.fbx`.
CLIP_NAME = re.compile(r"^[A-Za-z0-9 _.()-]{1,80}$")
MAX_CLIPS = 16
BLENDER_TIMEOUT_SECONDS = 900.0
MODES = ("rig", "draft", "bind")
#: Where drafts live, under the output root.
DRAFTS = ".rig-drafts"
DRAFT_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
EDITED_WEIGHTS = "weights.edited.bin"


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


class BlenderFailed(RuntimeError):
    pass


@dataclass
class Job:
    #: The mesh to predict from; None when binding a draft, which has its own.
    mesh_path: Path | None
    #: The GLB to write; None for a draft, which writes none.
    out_path: Path | None
    #: What `blend.py` is given per clip: `builtin:<name>`, or an FBX path.
    clips: list[str]
    remove_fingers: bool = True
    inplace: bool = True
    compress_textures: bool = True
    texture_quality: int = 100
    mode: str = "rig"
    draft_dir: Path | None = None
    #: Bone name -> {"head": [x, y, z], "tail": [x, y, z]}, for `bind`.
    bones: dict[str, Any] | None = None


@dataclass
class RigReport:
    seconds_total: float
    out_path: str
    out_bytes: int
    bones: int
    vertices: int
    faces: int
    clips: list[str]
    peak_vram_gib: float
    vram_scope: str
    texture_bytes_before: int = 0
    texture_bytes_after: int = 0
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DraftReport:
    seconds_total: float
    draft: str
    bones: int
    vertices: int
    faces: int
    peak_vram_gib: float
    vram_scope: str
    stages: list[dict[str, Any]] = field(default_factory=list)


def _inside(root: Path, candidate: str, what: str) -> Path:
    if not candidate or "\x00" in candidate:
        raise JobError(f"{what} is required")
    if Path(candidate).is_absolute() or re.match(r"^[A-Za-z]:", candidate):
        raise JobError(f"{what} must be relative to the arm's own directory")
    resolved = (root / candidate).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise JobError(f"{what} resolves outside {root_resolved}")
    return resolved


def _bool(body: dict[str, Any], key: str, default: bool) -> bool:
    value = body.get(key, default)
    if not isinstance(value, bool):
        raise JobError(f"{key} must be true or false")
    return value


def available_clips(clip_dir: Path) -> list[str]:
    if not clip_dir.is_dir():
        return []
    return sorted(path.stem for path in clip_dir.glob("*.fbx") if CLIP_NAME.match(path.stem))


def _draft_dir(out_dir: Path, value: Any) -> Path:
    raw = str(value or "")
    parts = raw.replace("\\", "/").split("/")
    if len(parts) != 2 or parts[0] != DRAFTS or not DRAFT_ID.match(parts[1]):
        raise JobError(f"draftDir must be {DRAFTS}/<id>")
    return _inside(out_dir, raw, "draftDir")


def _clips(body: dict[str, Any], clip_dir: Path) -> list[str]:
    raw = body.get("clips", [])
    if not isinstance(raw, list) or len(raw) > MAX_CLIPS:
        raise JobError(f"clips must be a list of at most {MAX_CLIPS} names")
    clips = []
    for name in raw:
        if not isinstance(name, str) or not CLIP_NAME.match(name):
            raise JobError(f"clip {name!r} is not a clip name")
        if name in BUILTIN:
            arg = f"builtin:{name}"
        else:
            path = clip_dir / f"{name}.fbx"
            if not path.is_file():
                raise JobError(f"clip {name!r} is neither built in nor in {clip_dir}")
            arg = str(path)
        if arg not in clips:
            clips.append(arg)
    return clips


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path, clip_dir: Path) -> Job:
    mode = body.get("mode", "rig")
    if mode not in MODES:
        raise JobError(f"mode must be one of {', '.join(MODES)}")

    out_path = None
    if mode != "draft":
        out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
        if out_path.suffix.lower() != ".glb":
            raise JobError("outPath must end in .glb")

    mesh_path = None
    if mode != "bind":
        mesh_path = _inside(in_dir, str(body.get("meshPath") or ""), "meshPath")
        if mesh_path.suffix.lower() != ".glb" or not mesh_path.is_file():
            raise JobError("meshPath must be a GLB that exists")

    draft_dir = None
    if mode != "rig":
        draft_dir = _draft_dir(out_dir, body.get("draftDir"))
        if mode == "bind" and not (draft_dir / "rig.npz").is_file():
            raise JobError(f"{body.get('draftDir')} is not a draft -- detect the rig again")

    bones = body.get("bones")
    if bones is not None and (mode != "bind" or not isinstance(bones, dict)):
        raise JobError("bones is an object of bone edits, and only for mode bind")

    quality = body.get("textureQuality", 100)
    if isinstance(quality, bool) or not isinstance(quality, (int, float)) or not 1 <= int(quality) <= 100:
        raise JobError("textureQuality must be between 1 and 100")

    return Job(
        mesh_path=mesh_path,
        out_path=out_path,
        clips=_clips(body, clip_dir) if mode != "draft" else [],
        remove_fingers=_bool(body, "removeFingers", True),
        inplace=_bool(body, "inPlace", True),
        compress_textures=_bool(body, "compressTextures", True),
        texture_quality=int(quality),
        mode=mode,
        draft_dir=draft_dir,
        bones=bones,
    )


def _stages(progress: JobProgress) -> list[dict[str, Any]]:
    for step in progress.snapshot().get("steps", []):
        if step.get("key") == "rig":
            return [
                {"name": child.get("label", child.get("key", "")), "seconds": child.get("seconds", 0.0)}
                for child in step.get("children", [])
            ]
    return []


def clip_name(arg: str) -> str:
    return arg[len("builtin:") :] if arg.startswith("builtin:") else Path(arg).stem


def run_blender(npz: Path, out: Path, template: Path, clips: list[str], cwd: Path) -> dict[str, Any]:
    env_path = str(Path(__file__).resolve().parents[1])
    proc = subprocess.run(  # noqa: S603 - our own interpreter and module, paths we built
        [sys.executable, "-m", "arm_mia.blend", str(npz), str(out), str(template), *clips],
        cwd=str(cwd),
        env={**__import__("os").environ, "PYTHONPATH": env_path},
        capture_output=True,
        text=True,
        timeout=BLENDER_TIMEOUT_SECONDS,
        check=False,
    )
    result = next(
        (line[len("RESULT ") :] for line in reversed(proc.stdout.splitlines()) if line.startswith("RESULT ")),
        None,
    )
    if result is None or not out.is_file():
        tail = "\n".join((proc.stderr or proc.stdout).splitlines()[-12:])
        raise BlenderFailed(f"Blender exited {proc.returncode} without a GLB:\n{tail}")
    return json.loads(result)


def _need(value: Path | None, what: str) -> Path:
    """A path this mode requires, which `parse_job` has already insisted on."""
    if value is None:
        raise JobError(f"{what} is required for this mode")
    return value


def _predict(engine: Engine, job: Job, progress: JobProgress, scratch: Path) -> dict[str, Any]:
    """Read the mesh, run the networks, and finalise: the rig as it would be bound."""
    source = _need(job.mesh_path, "meshPath")
    with progress.step("prepare", "Read the mesh", source.name, parent="rig") as step:
        mesh = scratch / "input.glb"
        converted = decompress_textures(source, mesh)
        step.detail(f"{converted} WebP map{'' if converted == 1 else 's'} → PNG" if converted else "PNG maps")

    with progress.step("predict", "Predict joints, weights, T-pose", parent="rig") as step:
        data = rigdata.finalise(engine.predict(mesh, job.remove_fingers, job.inplace))
        step.detail(f"{len(data['mesh'].vertices):,} vertices · {len(data['bones_idx_dict'])} bones")
    return data


def _draft(engine: Engine, job: Job, progress: JobProgress, scratch: Path, started: float) -> DraftReport:
    draft_dir = _need(job.draft_dir, "draftDir")
    detail = "for review" + (" · fingers folded" if job.remove_fingers else "")
    with progress.step("rig", "Detect rig", detail):
        data = _predict(engine, job, progress, scratch)
        with progress.step("draft", "Write the draft", draft_dir.name, parent="rig"):
            shutil.rmtree(draft_dir, ignore_errors=True)
            described = rigdata.write_draft(draft_dir, data)
    return DraftReport(
        seconds_total=time.perf_counter() - started,
        draft=draft_dir.name,
        bones=len(described["bones"]),
        vertices=int(described["vertexCount"]),
        faces=int(described["faceCount"]),
        peak_vram_gib=progress.peak_gib,
        vram_scope="process",
        stages=_stages(progress),
    )


def _bind(job: Job, progress: JobProgress, scratch: Path, template: Path) -> tuple[dict[str, Any], int, int]:
    """Blender and WebP: the GLB out of a finalised rig saved as `scratch/rig.npz`."""
    out_path = _need(job.out_path, "outPath")
    label = "Bind, retarget clips, export" if job.clips else "Bind and export"
    names = ", ".join(clip_name(c) for c in job.clips) or None
    with progress.step("blender", label, names, parent="rig"):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result = run_blender(scratch / "rig.npz", out_path, template, job.clips, scratch)

    before = after = 0
    if job.compress_textures:
        how = "WebP lossless" if job.texture_quality >= 100 else f"WebP q{job.texture_quality}"
        with progress.step("compress", "Compress textures", how, parent="rig") as step:
            try:
                report = compress_textures(out_path, job.texture_quality)
                before, after = report.bytes_before, report.bytes_after
                step.detail(f"{how} · {before / 2**20:.1f} → {after / 2**20:.1f} MiB")
            except Exception as error:  # noqa: BLE001 - a PNG rig is still a rig
                step.detail(f"skipped: {type(error).__name__}: {error}")
    return result, before, after


def _edited(job: Job, progress: JobProgress) -> dict[str, Any]:
    """The draft, with the bones and weights the person changed."""
    draft_dir = _need(job.draft_dir, "draftDir")
    with progress.step("edits", "Apply your edits", parent="rig") as step:
        data = rigdata.load(draft_dir / "rig.npz")
        edited = draft_dir / EDITED_WEIGHTS
        blob = edited.read_bytes() if edited.is_file() else None
        try:
            data = rigdata.apply_edits(data, job.bones, blob)
        except rigdata.EditError as error:
            raise JobError(str(error)) from error
        moved = len(job.bones or {})
        repainted = " · weights repainted" if blob is not None else ""
        step.detail(f"{moved} bone{'' if moved == 1 else 's'} moved{repainted}")
    return data


def generate(
    engine: Engine, job: Job, progress: JobProgress, scratch_root: Path, template: Path
) -> RigReport | DraftReport:
    started = time.perf_counter()
    stem = job.out_path.stem if job.out_path is not None else f"draft-{_need(job.draft_dir, 'draftDir').name}"
    scratch = scratch_root / stem
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)

    try:
        if job.mode == "draft":
            return _draft(engine, job, progress, scratch, started)

        detail = f"{len(job.clips)} clip{'' if len(job.clips) == 1 else 's'}" + (
            " · fingers folded into hands" if job.remove_fingers else ""
        )
        if job.mode == "bind":
            detail = "reviewed draft · " + detail
        with progress.step("rig", "Rig", detail):
            data = _edited(job, progress) if job.mode == "bind" else _predict(engine, job, progress, scratch)
            rigdata.save(scratch / "rig.npz", data)
            result, before, after = _bind(job, progress, scratch, template)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    out_path = _need(job.out_path, "outPath")
    return RigReport(
        seconds_total=time.perf_counter() - started,
        out_path=str(out_path),
        out_bytes=out_path.stat().st_size,
        bones=int(result["bones"]),
        vertices=int(result["vertices"]),
        faces=int(result["faces"]),
        clips=list(result["clips"]),
        peak_vram_gib=progress.peak_gib,
        vram_scope="process",
        texture_bytes_before=before,
        texture_bytes_after=after,
        stages=_stages(progress),
    )

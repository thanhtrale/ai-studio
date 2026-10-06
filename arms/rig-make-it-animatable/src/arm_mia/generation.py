"""One rig job: validate it, predict the rig, hand it to Blender, file the GLB.

The input is a mesh the studio already has -- staged under `inputDir` by the
route, as reference images are -- and the output is that mesh with a Mixamo
skeleton, skin weights and the chosen clips, one GLB three.js plays with an
`AnimationMixer`.
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

from .builtin_clips import BUILTIN
from .engine import Engine
from .progress import JobProgress
from .webp import compress_textures, decompress_textures

#: A clip name is a file name in the clip folder, without `.fbx`.
CLIP_NAME = re.compile(r"^[A-Za-z0-9 _.()-]{1,80}$")
MAX_CLIPS = 16
BLENDER_TIMEOUT_SECONDS = 900.0


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


class BlenderFailed(RuntimeError):
    pass


@dataclass
class Job:
    mesh_path: Path
    out_path: Path
    #: What `blend.py` is given per clip: `builtin:<name>`, or an FBX path.
    clips: list[str]
    remove_fingers: bool = True
    inplace: bool = True
    compress_textures: bool = True
    texture_quality: int = 100


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


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path, clip_dir: Path) -> Job:
    out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
    if out_path.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")
    mesh_path = _inside(in_dir, str(body.get("meshPath") or ""), "meshPath")
    if mesh_path.suffix.lower() != ".glb" or not mesh_path.is_file():
        raise JobError("meshPath must be a GLB that exists")

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

    quality = body.get("textureQuality", 100)
    if isinstance(quality, bool) or not isinstance(quality, (int, float)) or not 1 <= int(quality) <= 100:
        raise JobError("textureQuality must be between 1 and 100")

    return Job(
        mesh_path=mesh_path,
        out_path=out_path,
        clips=clips,
        remove_fingers=_bool(body, "removeFingers", True),
        inplace=_bool(body, "inPlace", True),
        compress_textures=_bool(body, "compressTextures", True),
        texture_quality=int(quality),
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


def generate(
    engine: Engine, job: Job, progress: JobProgress, scratch_root: Path, template: Path
) -> RigReport:
    started = time.perf_counter()
    scratch = scratch_root / job.out_path.stem
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)
    detail = f"{len(job.clips)} clip{'' if len(job.clips) == 1 else 's'}" + (
        " · fingers folded into hands" if job.remove_fingers else ""
    )

    try:
        with progress.step("rig", "Rig", detail):
            with progress.step("prepare", "Read the mesh", job.mesh_path.name, parent="rig") as step:
                mesh = scratch / "input.glb"
                converted = decompress_textures(job.mesh_path, mesh)
                step.detail(
                    f"{converted} WebP map{'' if converted == 1 else 's'} → PNG" if converted else "PNG maps"
                )

            with progress.step("predict", "Predict joints, weights, T-pose", parent="rig") as step:
                predicted = engine.predict(mesh, scratch, job.remove_fingers, job.inplace)
                step.detail(f"{predicted.vertices:,} vertices")

            label = "Bind, retarget clips, export" if job.clips else "Bind and export"
            names = ", ".join(clip_name(c) for c in job.clips) or None
            with progress.step("blender", label, names, parent="rig"):
                job.out_path.parent.mkdir(parents=True, exist_ok=True)
                result = run_blender(predicted.npz, job.out_path, template, job.clips, scratch)

            before = after = 0
            if job.compress_textures:
                how = "WebP lossless" if job.texture_quality >= 100 else f"WebP q{job.texture_quality}"
                with progress.step("compress", "Compress textures", how, parent="rig") as step:
                    try:
                        report = compress_textures(job.out_path, job.texture_quality)
                        before, after = report.bytes_before, report.bytes_after
                        step.detail(f"{how} · {before / 2**20:.1f} → {after / 2**20:.1f} MiB")
                    except Exception as error:  # noqa: BLE001 - a PNG rig is still a rig
                        step.detail(f"skipped: {type(error).__name__}: {error}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    return RigReport(
        seconds_total=time.perf_counter() - started,
        out_path=str(job.out_path),
        out_bytes=job.out_path.stat().st_size,
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

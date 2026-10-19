"""One job: validate it, cut the subject out, run Pixal3D, file the GLB.

The vocabulary is the other mesh arms' -- `refImages`, `outPath`, `seed`,
`targetFaces`, `textureSize` -- so the studio builds every body the same way.
This arm's own are `resolution` (the cascade's final grid), the three
samplers' `ssSteps` / `shapeSteps` / `texSteps` and `fov`.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from .engine import Engine, Params
from .progress import JobProgress

RESOLUTIONS = (512, 1024, 1536)
TEXTURE_SIZES = (1024, 2048, 4096)
MIN_FACES, MAX_FACES = 5_000, 1_000_000
RANDOM_SEED_CEILING = 2**31 - 1


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    out_path: Path
    reference: Path
    params: Params


def _inside(root: Path, rel: str, what: str) -> Path:
    if not rel:
        raise JobError(f"{what} is required")
    resolved = (root / rel).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise JobError(f"{what} resolves outside {root_resolved}")
    return resolved


def _number(body: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    if not low <= value <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return value


def _choice(body: dict[str, Any], key: str, default: int, choices: tuple[int, ...]) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) not in choices:
        raise JobError(f"{key} must be one of {', '.join(str(c) for c in choices)}")
    return int(value)


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path) -> Job:
    out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
    if out_path.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")
    refs = body.get("refImages") or []
    if not isinstance(refs, list) or len(refs) != 1 or not isinstance(refs[0], str):
        raise JobError("refImages must hold exactly one image path (Pixal3D is single-view)")
    reference = _inside(in_dir, refs[0], "refImages[0]")
    if not reference.is_file():
        raise JobError(f"reference image {refs[0]} not found")
    seed = int(_number(body, "seed", -1, -1, RANDOM_SEED_CEILING))
    params = Params(
        seed=secrets.randbelow(RANDOM_SEED_CEILING) if seed < 0 else seed,
        resolution=_choice(body, "resolution", 1024, RESOLUTIONS),
        ss_steps=int(_number(body, "ssSteps", 12, 4, 50)),
        shape_steps=int(_number(body, "shapeSteps", 12, 4, 50)),
        tex_steps=int(_number(body, "texSteps", 12, 4, 50)),
        ss_guidance=float(_number(body, "ssGuidance", 7.5, 1, 15)),
        shape_guidance=float(_number(body, "shapeGuidance", 7.5, 1, 15)),
        target_faces=int(_number(body, "targetFaces", 150_000, MIN_FACES, MAX_FACES)),
        texture_size=_choice(body, "textureSize", 4096, TEXTURE_SIZES),
        fov=float(_number(body, "fov", -1, -1, 1.5)),
    )
    return Job(out_path=out_path, reference=reference, params=params)


def generate(engine: Engine, job: Job, progress: JobProgress) -> dict[str, Any]:
    started = time.perf_counter()
    p = job.params
    with progress.step("cutout", "Cut out the subject", engine.paths.rembg_model):
        photo = Image.open(job.reference)
        photo.load()
        cut = engine.cutout(photo)
    scratch = job.out_path.with_name(f"_prep_{job.out_path.stem}.png")
    info = engine.generate(cut, scratch, job.out_path, p, progress)
    return {
        "secondsTotal": round(time.perf_counter() - started, 1),
        "seed": p.seed,
        "resolution": p.resolution,
        "meshes": [
            {"outPath": str(job.out_path), "outBytes": job.out_path.stat().st_size, "seed": p.seed, **info}
        ],
        "peakVramGib": round(progress.peak_gib, 2),
        "stages": [{"name": s["label"], "seconds": s["seconds"]} for s in progress.snapshot()["steps"]],
    }

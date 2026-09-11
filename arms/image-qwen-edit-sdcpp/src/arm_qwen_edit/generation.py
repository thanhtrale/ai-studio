"""One job: validate it, hand it to the child, and file what comes back.

The arm owns two things the child does not: where a file may be read from and
where it may be written to. Everything in `parse_job` exists because the job
payload arrives over HTTP from another process, and a path in it is a path
someone can choose.
"""

from __future__ import annotations

import base64
import binascii
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .progress import JobProgress
from .runtime import SdServer

# sd.cpp names its samplers and schedulers in lowercase with punctuation
# ("euler_a", "dpm++2m"). Validated by shape rather than by list: a build that
# adds one should not need this arm changed, and the child rejects a name it
# does not know with a message this arm passes straight back.
NAME = re.compile(r"^[a-z0-9_+.\-]{1,32}$")

MAX_BATCH = 16
MAX_REFERENCES = 4
MAX_STEPS = 100
MAX_EDGE = 4096
# Qwen-Image works in 16-pixel blocks: an 8x VAE and a 2x patch embed on top.
EDGE_MULTIPLE = 16
OUTPUT_FORMAT = "png"
POLL_SECONDS = 0.4
# An hour. Nothing this card runs takes that long, but an unbounded poll on a
# wedged child is a hang with no message, which is the worse failure.
JOB_TIMEOUT_SECONDS = 3600.0


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    prompt: str
    negative_prompt: str
    out_path: Path
    width: int
    height: int
    steps: int
    cfg_scale: float
    sampler: str
    scheduler: str
    flow_shift: float
    seed: int
    batch: int
    strength: float
    references: list[Path] = field(default_factory=list)


@dataclass
class ImageOut:
    out_path: str
    out_bytes: int
    index: int
    seed: int


@dataclass
class GenerationReport:
    seconds_total: float
    steps: int
    seed: int
    batch: int
    width: int
    height: int
    images: list[ImageOut]
    peak_vram_reserved_gib: float
    stages: list[dict[str, Any]]
    prompt_used: str | None = None


def _inside(root: Path, candidate: str, what: str) -> Path:
    """A job-supplied path, resolved and proven to be under `root`.

    `resolve()` before the comparison, so that a symlink or a `..` that leaves
    the root is caught by where it lands rather than by how it is spelled.
    """
    if not candidate or "\x00" in candidate:
        raise JobError(f"{what} is required")
    if Path(candidate).is_absolute() or re.match(r"^[A-Za-z]:", candidate):
        raise JobError(f"{what} must be relative to the arm's own directory")

    resolved = (root / candidate).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise JobError(f"{what} resolves outside {root_resolved}")
    return resolved


def _int(body: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    number = int(value)
    if not low <= number <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return number


def _float(body: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    number = float(value)
    if not low <= number <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return number


def _name(body: dict[str, Any], key: str, default: str) -> str:
    value = body.get(key, default) or default
    if not isinstance(value, str) or not NAME.match(value):
        raise JobError(f"{key} is not a sampler or scheduler name")
    return value


def _edge(body: dict[str, Any], key: str, default: int) -> int:
    value = _int(body, key, default, EDGE_MULTIPLE, MAX_EDGE)
    if value % EDGE_MULTIPLE:
        raise JobError(f"{key} must be a multiple of {EDGE_MULTIPLE}")
    return value


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path) -> Job:
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("prompt is required")

    negative = body.get("negativePrompt") or ""
    if not isinstance(negative, str):
        raise JobError("negativePrompt must be a string")

    out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
    if out_path.suffix.lower() != f".{OUTPUT_FORMAT}":
        raise JobError(f"outPath must end in .{OUTPUT_FORMAT}")

    raw_refs = body.get("refImages") or []
    if not isinstance(raw_refs, list):
        raise JobError("refImages must be a list")
    if len(raw_refs) > MAX_REFERENCES:
        raise JobError(f"at most {MAX_REFERENCES} reference images")

    references: list[Path] = []
    for entry in raw_refs:
        if not isinstance(entry, str):
            raise JobError("every reference image must be a path")
        resolved = _inside(in_dir, entry, "refImages")
        if not resolved.is_file():
            raise JobError(f"reference image {entry} is not there")
        references.append(resolved)

    seed = _int(body, "seed", -1, -1, 2**31 - 1)

    return Job(
        prompt=prompt.strip(),
        negative_prompt=negative.strip(),
        out_path=out_path,
        width=_edge(body, "width", 1024),
        height=_edge(body, "height", 1024),
        steps=_int(body, "steps", 4, 1, MAX_STEPS),
        cfg_scale=_float(body, "cfgScale", 1.0, 0.0, 30.0),
        sampler=_name(body, "sampler", "euler"),
        scheduler=_name(body, "scheduler", "discrete"),
        flow_shift=_float(body, "flowShift", 3.0, 0.0, 10.0),
        seed=seed,
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        strength=_float(body, "strength", 0.75, 0.0, 1.0),
        references=references,
    )


def _data_url(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def request_body(job: Job) -> dict[str, Any]:
    """The job in the child's own vocabulary.

    Reference images travel as base64 rather than as paths: the child's API
    takes images inline, and that is the safer half of the bargain anyway --
    the child is never told a filesystem location this arm has not already
    read from.
    """
    return {
        "prompt": job.prompt,
        "negative_prompt": job.negative_prompt,
        "width": job.width,
        "height": job.height,
        "seed": job.seed,
        "batch_count": job.batch,
        "strength": job.strength,
        "ref_images": [_data_url(path) for path in job.references],
        "output_format": OUTPUT_FORMAT,
        "sample_params": {
            "sample_method": job.sampler,
            "sample_steps": job.steps,
            "scheduler": job.scheduler,
            "flow_shift": job.flow_shift,
            "guidance": {"txt_cfg": job.cfg_scale},
        },
    }


def _paths_for(job: Job) -> list[Path]:
    """Where a batch lands: `name.png`, then `name-2.png`, `name-3.png`.

    The first image keeps the unsuffixed name the caller planned, so a batch of
    one is indistinguishable from a single generation -- which is what the
    library's records assume when they point at a file.
    """
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
            for index in range(job.batch)]


def _decode(entry: Any) -> bytes:
    payload = entry.get("b64_json") if isinstance(entry, dict) else None
    if not isinstance(payload, str) or not payload:
        raise RuntimeError("the child returned an image with no data")
    # Data URLs are allowed on the way in, so allow them on the way back too.
    if payload.startswith("data:"):
        payload = payload.split(",", 1)[-1]
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RuntimeError(f"the child returned an image that is not base64: {error}") from error


def _stages(progress: JobProgress) -> list[dict[str, Any]]:
    """The phases the child's log announced, as the report's stage list."""
    snapshot = progress.snapshot()
    for step in snapshot.get("steps", []):
        if step.get("key") == "generate":
            return [
                {"name": child.get("label", child.get("key", "")), "seconds": child.get("seconds", 0.0)}
                for child in step.get("children", [])
            ]
    return []


def generate(server: SdServer, job: Job, progress: JobProgress) -> GenerationReport:
    started = time.perf_counter()
    scan = server.reset_scan()

    detail = f"{job.width}×{job.height} · {job.steps} step · cfg {job.cfg_scale:g}"
    if job.batch > 1:
        detail += f" · ×{job.batch}"
    if job.references:
        detail += f" · {len(job.references)} reference"

    with progress.step("generate", "Generate", detail) as reported:
        submitted = server.post("/sdcpp/v1/img_gen", request_body(job))
        child_id = submitted.get("id")
        if not isinstance(child_id, str) or not child_id:
            raise RuntimeError(f"the child accepted the job without naming it: {submitted}")

        result = _await_job(server, child_id)
        images = result.get("images")
        if not isinstance(images, list) or not images:
            raise RuntimeError("the child finished without returning an image")

        written: list[ImageOut] = []
        destinations = _paths_for(job)
        for index, entry in enumerate(images):
            # More images than planned names would mean the child ignored
            # batch_count; give the extras names of the same shape rather than
            # dropping them on the floor.
            target = (
                destinations[index]
                if index < len(destinations)
                else job.out_path.with_name(f"{job.out_path.stem}-{index + 1}{job.out_path.suffix}")
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = _decode(entry)
            target.write_bytes(payload)
            written.append(
                ImageOut(
                    out_path=str(target),
                    out_bytes=len(payload),
                    index=index,
                    seed=scan.seeds[index] if index < len(scan.seeds) else job.seed,
                )
            )

        reported.detail(f"{detail} · {len(written)} file{'' if len(written) == 1 else 's'}")

    return GenerationReport(
        seconds_total=time.perf_counter() - started,
        steps=scan.steps_total or job.steps,
        seed=written[0].seed,
        batch=job.batch,
        width=job.width,
        height=job.height,
        images=written,
        peak_vram_reserved_gib=progress.peak_gib,
        stages=_stages(progress),
    )


def _await_job(server: SdServer, child_id: str) -> dict[str, Any]:
    """Poll the child until its job ends, and return the result it produced."""
    deadline = time.monotonic() + JOB_TIMEOUT_SECONDS
    status: Any = None

    while time.monotonic() < deadline:
        if not server.running:
            raise RuntimeError(f"sd-server died while generating:\n{server.tail()}")

        answer = server.get(f"/sdcpp/v1/jobs/{child_id}", timeout=30.0)
        status = answer.get("status")

        if status == "completed":
            result = answer.get("result")
            if not isinstance(result, dict):
                raise RuntimeError("the child reported completion with no result")
            return result
        if status in {"failed", "cancelled"}:
            reason = answer.get("error") or server.scan.last_error or status
            raise RuntimeError(f"the child {status}: {reason}")

        time.sleep(POLL_SECONDS)

    raise RuntimeError(f"the child was still {status!r} after {JOB_TIMEOUT_SECONDS:.0f}s")

"""One job: validate it, queue it a prompt at a time, and file what comes back.

The arm owns two things ComfyUI does not: where a file may be read from and
where it may be written to. Everything in `parse_job` exists because the job
payload arrives over HTTP from another process, and a path in it is a path
someone can choose.

The job schema is deliberately the same one the stable-diffusion.cpp arm took.
The studio's web route builds that body and knows nothing about either backend,
so keeping the vocabulary identical is what lets this arm replace that one
without a change above it.
"""

from __future__ import annotations

import re
import secrets
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import graph as graph_module
from .graph import MAX_REFERENCES, Models, Sampling
from .progress import JobProgress
from .runtime import ChildFailed, ComfyServer

# ComfyUI names its samplers and schedulers in lowercase with punctuation
# ("euler_ancestral", "dpmpp_2m_sde_gpu"). Validated by shape rather than by
# list: a ComfyUI that adds one should not need this arm changed, and the child
# rejects a name it does not know with a message this arm passes straight back.
NAME = re.compile(r"^[a-z0-9_+.\-/]{1,40}$")

# One image is one ComfyUI prompt, so a batch costs no extra VRAM and there is
# no child ceiling to respect -- the sd.cpp arm this replaced had one, and it
# is gone with it. What is left is time, and a ceiling that says so: a batch is
# a number someone can mistype, and this arm holds the card until it is done.
MAX_BATCH = 100
MAX_STEPS = 100
MAX_EDGE = 4096
# Qwen-Image works in 16-pixel blocks: an 8x VAE and a 2x patch embed on top.
EDGE_MULTIPLE = 16
OUTPUT_FORMAT = "png"
POLL_SECONDS = 0.4
# An hour. Nothing this card runs takes that long, but an unbounded poll on a
# wedged child is a hang with no message, which is the worse failure.
JOB_TIMEOUT_SECONDS = 3600.0
# KSampler's own ceiling. A seed above it is refused by the child rather than
# wrapped, so the arm keeps its arithmetic inside the range.
MAX_SEED = 0xFFFFFFFFFFFFFFFF
# The studio hands out signed 32-bit seeds, and a batch walks upwards from one.
RANDOM_SEED_CEILING = 2**31 - 1


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
    seed: int
    batch: int
    sampler: str = graph_module.DEFAULT_SAMPLER
    scheduler: str = graph_module.DEFAULT_SCHEDULER
    shift: float = graph_module.DEFAULT_SHIFT
    #: Reference images, relative to ComfyUI's input directory, forward-slashed
    #: because that is how `LoadImage` names a file in a subfolder.
    references: list[str] = field(default_factory=list)


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
    peak_vram_gib: float
    #: What `peak_vram_gib` is a measurement *of*: "process", "card", or
    #: "unavailable". Not cosmetic -- a whole-card peak filed as this arm's own
    #: would overstate it by whatever else was on the GPU.
    vram_scope: str
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


def _name(body: dict[str, Any], key: str, fallback: str) -> str:
    """A sampler or scheduler name, or the blueprint's own when unset.

    Unlike the sd.cpp arm there is no "let the model decide": ComfyUI's
    `KSampler` has no such value, so an empty request falls back to what
    ComfyUI's Qwen 2511 blueprint ships with rather than to nothing.
    """
    value = body.get(key)
    if value is None or value == "":
        return fallback
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
        raise JobError(
            f"at most {MAX_REFERENCES} reference images -- "
            "ComfyUI's Qwen edit encoder takes image1 through image3 and no more"
        )

    references: list[str] = []
    for entry in raw_refs:
        if not isinstance(entry, str):
            raise JobError("every reference image must be a path")
        resolved = _inside(in_dir, entry, "refImages")
        if not resolved.is_file():
            raise JobError(f"reference image {entry} is not there")
        # Named to ComfyUI the way it names its own input files: relative to
        # the input directory, forward-slashed whatever this platform uses.
        references.append(resolved.relative_to(in_dir.resolve()).as_posix())

    return Job(
        prompt=prompt.strip(),
        negative_prompt=negative.strip(),
        out_path=out_path,
        width=_edge(body, "width", 1024),
        height=_edge(body, "height", 1024),
        steps=_int(body, "steps", 20, 1, MAX_STEPS),
        cfg_scale=_float(body, "cfgScale", 2.5, 0.0, 30.0),
        sampler=_name(body, "sampler", graph_module.DEFAULT_SAMPLER),
        scheduler=_name(body, "scheduler", graph_module.DEFAULT_SCHEDULER),
        shift=(
            graph_module.DEFAULT_SHIFT
            if body.get("flowShift") is None
            else _float(body, "flowShift", graph_module.DEFAULT_SHIFT, 0.0, 10.0)
        ),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        references=references,
    )


def seeds_for(job: Job) -> list[int]:
    """One seed per image, so each file is reproducible on its own.

    A requested seed walks upwards through the batch; an unset one is drawn
    once per image, because four random images that share a seed would be four
    copies of the same image.
    """
    if job.seed < 0:
        return [secrets.randbelow(RANDOM_SEED_CEILING) for _ in range(job.batch)]
    return [min(job.seed + index, MAX_SEED) for index in range(job.batch)]


def paths_for(job: Job) -> list[Path]:
    """Where a batch lands: `name.png`, then `name-2.png`, `name-3.png`.

    The first image keeps the unsuffixed name the caller planned, so a batch of
    one is indistinguishable from a single generation -- which is what the
    library's records assume when they point at a file.
    """
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [
        job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
        for index in range(job.batch)
    ]


def sampling_for(job: Job, seed: int) -> Sampling:
    return Sampling(
        prompt=job.prompt,
        negative_prompt=job.negative_prompt,
        width=job.width,
        height=job.height,
        steps=job.steps,
        cfg=job.cfg_scale,
        seed=seed,
        sampler=job.sampler,
        scheduler=job.scheduler,
        shift=job.shift,
        references=job.references,
    )


def _saved_images(history: dict[str, Any]) -> list[dict[str, Any]]:
    """The files the `SaveImage` node reported, in the order it saved them."""
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        return []
    node = outputs.get(graph_module.SAVE)
    images = node.get("images") if isinstance(node, dict) else None
    return [entry for entry in images or [] if isinstance(entry, dict)]


def _await_prompt(server: ComfyServer, prompt_id: str) -> dict[str, Any]:
    """Poll until ComfyUI files this prompt in its history, and return it.

    History rather than the websocket: a socket that drops mid-job would take
    the only record of completion with it, whereas history is the child's own
    durable answer and is what it serves its own UI from. The websocket's one
    advantage -- per-step granularity -- is covered by reading the log.
    """
    deadline = time.monotonic() + JOB_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        if not server.running:
            raise ChildFailed(f"ComfyUI died while generating:\n{server.tail()}")

        answer = server.get(f"/history/{prompt_id}", timeout=30.0)
        entry = answer.get(prompt_id) if isinstance(answer, dict) else None
        if isinstance(entry, dict):
            status = entry.get("status") or {}
            if status.get("status_str") == "error" or status.get("completed") is False:
                reason = _failure_reason(status) or server.scan.last_error or "no reason given"
                raise ChildFailed(f"ComfyUI failed the prompt: {reason}")
            return entry

        time.sleep(POLL_SECONDS)

    raise ChildFailed(f"ComfyUI did not finish the prompt within {JOB_TIMEOUT_SECONDS:.0f}s")


def _failure_reason(status: dict[str, Any]) -> str | None:
    """The first thing in a failed prompt's messages that reads like a cause."""
    for message in status.get("messages") or []:
        if not isinstance(message, (list, tuple)) or len(message) < 2:
            continue
        kind, payload = message[0], message[1]
        if kind != "execution_error" or not isinstance(payload, dict):
            continue
        node = payload.get("node_type") or payload.get("node_id")
        detail = payload.get("exception_message") or payload.get("exception_type")
        return f"{node}: {detail}" if node else str(detail)
    return None


def _collect(server: ComfyServer, entry: dict[str, Any], target: Path, index: int, seed: int) -> ImageOut:
    """Move the one file this prompt produced out of ComfyUI's own output tree.

    Moved rather than copied, and moved rather than left in place: the scratch
    directory is the child's, the library's directory is the studio's, and a
    generation that lives in both is a generation that can be cleaned up from
    under its own record.
    """
    images = _saved_images(entry)
    if not images:
        raise ChildFailed("ComfyUI finished the prompt without saving an image")
    if len(images) > 1:
        # One prompt is one image by construction. More means the graph was not
        # the one this arm built, which is worth saying rather than guessing at.
        raise ChildFailed(f"ComfyUI saved {len(images)} images for a single-image prompt")

    saved = images[0]
    filename = saved.get("filename")
    if not isinstance(filename, str) or not filename:
        raise ChildFailed("ComfyUI saved an image without naming it")

    subfolder = saved.get("subfolder") or ""
    source = server.config.scratch_dir / "output"
    if subfolder:
        source = source / subfolder
    source = source / filename

    if not source.is_file():
        raise ChildFailed(f"ComfyUI said it wrote {source}, and it is not there")

    target.parent.mkdir(parents=True, exist_ok=True)
    # shutil rather than Path.replace: the scratch directory and the library
    # are both under managed storage but need not be on the same volume.
    shutil.move(str(source), str(target))

    return ImageOut(out_path=str(target), out_bytes=target.stat().st_size, index=index, seed=seed)


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


def generate(server: ComfyServer, models: Models, job: Job, progress: JobProgress) -> GenerationReport:
    started = time.perf_counter()

    detail = f"{job.width}×{job.height} · {job.steps} step · cfg {job.cfg_scale:g}"
    if job.batch > 1:
        detail += f" · ×{job.batch}"
    if job.references:
        detail += f" · {len(job.references)} reference"

    seeds = seeds_for(job)
    destinations = paths_for(job)
    written: list[ImageOut] = []

    with progress.step("generate", "Generate", detail) as reported:
        if job.batch > 1:
            progress.meter("batch", "Images", job.batch)

        for index, (seed, target) in enumerate(zip(seeds, destinations, strict=True)):
            if job.batch > 1:
                progress.advance("batch", index, job.batch)
                reported.detail(f"{detail} · image {index + 1} of {job.batch}")

            prompt_id = str(uuid.uuid4())
            server.begin_scan(job.steps)
            try:
                body = {
                    "prompt": graph_module.build(models, sampling_for(job, seed), f"aistudio/{prompt_id}"),
                    "prompt_id": prompt_id,
                }
                submitted = server.post("/prompt", body)
                node_errors = submitted.get("node_errors") if isinstance(submitted, dict) else None
                if node_errors:
                    raise ChildFailed(f"ComfyUI would not run the graph: {node_errors}")

                entry = _await_prompt(server, prompt_id)
            finally:
                server.end_scan()

            written.append(_collect(server, entry, target, index, seed))

        # The meter counts images as they *start*, so the last one leaves it
        # one short. A finished job shows all of them finished.
        if job.batch > 1:
            progress.advance("batch", len(written), job.batch)

        reported.detail(f"{detail} · {len(written)} file{'' if len(written) == 1 else 's'}")

    return GenerationReport(
        seconds_total=time.perf_counter() - started,
        steps=job.steps,
        seed=written[0].seed,
        batch=job.batch,
        width=job.width,
        height=job.height,
        images=written,
        peak_vram_gib=progress.peak_gib,
        # Filled in by the caller once the job is over. It cannot be known when
        # the job starts: what kind of reading this machine gives is discovered
        # by taking one, and the first is taken after the child exists.
        vram_scope="unavailable",
        stages=_stages(progress),
    )

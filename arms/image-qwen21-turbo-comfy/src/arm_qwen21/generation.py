"""One job: validate it, rewrite the prompt if asked, and file what comes back.

The job schema is deliberately the same one the edit arm takes. The studio's
web route builds that body and knows nothing about either backend, so keeping
the vocabulary identical is what lets both arms sit behind one console.

Three fields of that schema mean nothing here, and are accepted rather than
refused so a console switching between arms does not have to rewrite its
request: `cfgScale` (the distilled student runs unguided), `scheduler` and
`flowShift` (the sigma schedule is the LoRA's own, and its shift is computed
from the frame). The job's own step says so rather than leaving it a mystery.
"""

from __future__ import annotations

import json
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

# ComfyUI names its samplers in lowercase with punctuation. Validated by shape
# rather than by list: a ComfyUI that adds one should not need this arm
# changed, and the child rejects a name it does not know with a message this
# arm passes straight back.
NAME = re.compile(r"^[a-z0-9_+.\-/]{1,40}$")

# One image is one ComfyUI prompt, so a batch costs no extra VRAM and there is
# no child ceiling to respect. What is left is time, and a ceiling that says
# so: a batch is a number someone can mistype, and this arm holds the card
# until it is done.
MAX_BATCH = 100
# The LoRA is a six-step student. More than a handful of extra steps is not a
# schedule it was distilled for, and past about twenty it is only slower.
MAX_STEPS = 32
MAX_EDGE = 4096
# Qwen-Image 2.1's latent is a sixteenth scale, and the VAE wants a further 2.
EDGE_MULTIPLE = 32
OUTPUT_FORMAT = "png"
POLL_SECONDS = 0.4
JOB_TIMEOUT_SECONDS = 3600.0
MAX_SEED = 0xFFFFFFFFFFFFFFFF
RANDOM_SEED_CEILING = 2**31 - 1

#: Where the rewriter's system prompts live, verbatim from Viggle's workflows.
PROMPTS = Path(__file__).parent / "rewrite"


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
    seed: int
    batch: int
    enhance_prompt: bool = False
    sampler: str = graph_module.DEFAULT_SAMPLER
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
    vram_scope: str
    stages: list[dict[str, Any]]
    #: What reached the model. Differs from the request only when the enhancer
    #: ran, which is the same thing it means on the video arm.
    prompt_used: str | None = None


def _inside(root: Path, candidate: str, what: str) -> Path:
    """A job-supplied path, resolved and proven to be under `root`."""
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


def _name(body: dict[str, Any], key: str, fallback: str) -> str:
    value = body.get(key)
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not NAME.match(value):
        raise JobError(f"{key} is not a sampler name")
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
            "viggle-turbo was distilled on no more than three"
        )

    references: list[str] = []
    for entry in raw_refs:
        if not isinstance(entry, str):
            raise JobError("every reference image must be a path")
        resolved = _inside(in_dir, entry, "refImages")
        if not resolved.is_file():
            raise JobError(f"reference image {entry} is not there")
        references.append(resolved.relative_to(in_dir.resolve()).as_posix())

    enhance = body.get("enhancePrompt", False)
    if not isinstance(enhance, bool):
        raise JobError("enhancePrompt must be true or false")

    return Job(
        prompt=prompt.strip(),
        negative_prompt=negative.strip(),
        out_path=out_path,
        width=_edge(body, "width", 1024),
        height=_edge(body, "height", 1024),
        steps=_int(body, "steps", graph_module.DEFAULT_STEPS, 1, MAX_STEPS),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        enhance_prompt=enhance,
        sampler=_name(body, "sampler", graph_module.DEFAULT_SAMPLER),
        references=references,
    )


def seeds_for(job: Job) -> list[int]:
    """One seed per image, so each file is reproducible on its own."""
    if job.seed < 0:
        return [secrets.randbelow(RANDOM_SEED_CEILING) for _ in range(job.batch)]
    return [min(job.seed + index, MAX_SEED) for index in range(job.batch)]


def paths_for(job: Job) -> list[Path]:
    """Where a batch lands: `name.png`, then `name-2.png`, `name-3.png`."""
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [
        job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
        for index in range(job.batch)
    ]


def system_prompt_for(job: Job) -> str:
    """The rewriter's instructions: the edit one when there are references."""
    name = "edit.md" if job.references else "t2i.md"
    return (PROMPTS / name).read_text(encoding="utf-8")


def rewrite_request(job: Job) -> str:
    """What the rewriter is asked, in the shape Viggle's workflows ask it.

    The text-to-image rewriter is told the frame it is writing for, because it
    is expected to answer with a ratio and would otherwise pick its own.
    """
    if job.references:
        return f"{job.prompt}\n(Write the description in English.)"
    return f"{job.prompt}\nAspect ratio: {job.width}:{job.height}"


def parse_rewrite(answer: str) -> str | None:
    """The rewritten prompt out of the rewriter's JSON, or None.

    None rather than an exception: a rewrite is an improvement, and losing it
    is not a reason to fail a job that has a perfectly good prompt already.
    """
    text = answer.strip()
    if not text:
        return None
    # The rewriter is asked for JSON and mostly obliges, sometimes inside a
    # code fence. Anything else is read as the rewritten prompt itself.
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text or None
    if isinstance(parsed, dict):
        value = parsed.get("rewritten_prompt")
        return value.strip() or None if isinstance(value, str) else None
    return None


def _saved_images(history: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        return []
    node = outputs.get(graph_module.SAVE)
    images = node.get("images") if isinstance(node, dict) else None
    return [entry for entry in images or [] if isinstance(entry, dict)]


def _preview_text(history: dict[str, Any]) -> str:
    """Whatever `PreviewAny` put into the prompt's outputs."""
    outputs = history.get("outputs")
    node = outputs.get(graph_module.REWRITE_OUT) if isinstance(outputs, dict) else None
    text = node.get("text") if isinstance(node, dict) else None
    if isinstance(text, list) and text and isinstance(text[0], str):
        return text[0]
    return text if isinstance(text, str) else ""


def _failure_reason(status: dict[str, Any]) -> str | None:
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


def _await_prompt(server: ComfyServer, prompt_id: str) -> dict[str, Any]:
    """Poll until ComfyUI files this prompt in its history, and return it."""
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


def _submit(server: ComfyServer, graph: dict[str, Any]) -> dict[str, Any]:
    prompt_id = str(uuid.uuid4())
    submitted = server.post("/prompt", {"prompt": graph, "prompt_id": prompt_id})
    node_errors = submitted.get("node_errors") if isinstance(submitted, dict) else None
    if node_errors:
        raise ChildFailed(f"ComfyUI would not run the graph: {node_errors}")
    return _await_prompt(server, prompt_id)


def enhance(server: ComfyServer, models: Models, job: Job, progress: JobProgress) -> str | None:
    """The prompt as the rewriter would have written it, or None if it would not.

    Run once per job rather than once per image: the rewrite does not depend on
    the seed, and the text encoder is already loaded for it.
    """
    with progress.step("enhance", "Rewrite prompt", "Qwen3-VL", parent="generate") as reported:
        graph = graph_module.build_rewrite(
            models, rewrite_request(job), system_prompt_for(job), job.references
        )
        server.begin_scan(0, meter_key="rewrite", meter_label="Rewriter tokens")
        try:
            entry = _submit(server, graph)
        finally:
            server.end_scan()

        rewritten = parse_rewrite(_preview_text(entry))
        if rewritten is None:
            reported.detail("the rewriter answered with nothing usable; keeping the prompt as typed")
            return None
        reported.detail(f"{len(rewritten)} characters")
        return rewritten


def _collect(server: ComfyServer, entry: dict[str, Any], target: Path, index: int, seed: int) -> ImageOut:
    """Move the one file this prompt produced out of ComfyUI's own output tree."""
    images = _saved_images(entry)
    if not images:
        raise ChildFailed("ComfyUI finished the prompt without saving an image")
    if len(images) > 1:
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
    shutil.move(str(source), str(target))

    return ImageOut(out_path=str(target), out_bytes=target.stat().st_size, index=index, seed=seed)


def _stages(progress: JobProgress) -> list[dict[str, Any]]:
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

    detail = f"{job.width}×{job.height} · {job.steps} step · unguided"
    if job.batch > 1:
        detail += f" · ×{job.batch}"
    if job.references:
        detail += f" · {len(job.references)} reference"

    seeds = seeds_for(job)
    destinations = paths_for(job)
    written: list[ImageOut] = []

    with progress.step("generate", "Generate", detail) as reported:
        prompt_used: str | None = None
        if job.enhance_prompt:
            prompt_used = enhance(server, models, job, progress)

        if job.batch > 1:
            progress.meter("batch", "Images", job.batch)

        for index, (seed, target) in enumerate(zip(seeds, destinations, strict=True)):
            if job.batch > 1:
                progress.advance("batch", index, job.batch)
                reported.detail(f"{detail} · image {index + 1} of {job.batch}")

            sampling = Sampling(
                prompt=prompt_used or job.prompt,
                negative_prompt=job.negative_prompt,
                width=job.width,
                height=job.height,
                steps=job.steps,
                seed=seed,
                sampler=job.sampler,
                references=job.references,
            )

            server.begin_scan(job.steps)
            try:
                entry = _submit(
                    server, graph_module.build(models, sampling, f"aistudio/{uuid.uuid4()}")
                )
            finally:
                server.end_scan()

            written.append(_collect(server, entry, target, index, seed))

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
        vram_scope="unavailable",
        stages=_stages(progress),
        prompt_used=prompt_used,
    )

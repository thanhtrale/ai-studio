"""One job: validate it, sample it, and file what comes back.

The job schema is deliberately the image arms' vocabulary with a duration
bolted on. The studio's web route builds that body and knows nothing about the
backend, so keeping the words identical is what lets one console drive a
distilled image arm and a distilled video arm with the same controls.

Four fields arrive and mean nothing here, and are accepted rather than refused
so a console switching between arms does not have to rewrite its request:
`cfgScale` (the released checkpoints are CFG-distilled and sample unguided),
`sampler` (the turbo node supplies its own, which is the only one that steps
the audio correctly), `negativePrompt` (no guidance, nothing to steer away
from) and `frameRate` (the model was trained at 24 fps and its audio latents
are sized from seconds). The job's own step says so rather than leaving it a
mystery.
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
from .graph import MAX_KEYFRAMES, MAX_REFERENCES, Models, Sampling
from .progress import JobProgress
from .runtime import ChildFailed, ComfyServer

# ComfyUI names its schedulers in lowercase with punctuation. Validated by
# shape rather than by list: a ComfyUI that adds one should not need this arm
# changed, and the child rejects a name it does not know with a message this
# arm passes straight back.
NAME = re.compile(r"^[a-z0-9_+.\-/]{1,40}$")

# One clip is one ComfyUI prompt, so a batch costs no extra VRAM and there is
# no child ceiling to respect. What is left is time -- and unlike an image, a
# clip is minutes -- so the ceiling is low enough that a mistyped batch is an
# afternoon rather than a week.
MAX_BATCH = 16
MAX_STEPS = graph_module.MAX_STEPS
MAX_EDGE = 2048
MIN_EDGE = 256
EDGE_MULTIPLE = graph_module.CANVAS_MULTIPLE
# 15 seconds is the model's own ceiling; 362 frames is that at 24 fps on the
# 17k+5 grid.
MAX_FRAMES = 362
OUTPUT_FORMAT = graph_module.OUTPUT_FORMAT
POLL_SECONDS = 0.5
JOB_TIMEOUT_SECONDS = 7200.0
MAX_SEED = 0xFFFFFFFFFFFFFFFF
RANDOM_SEED_CEILING = 2**31 - 1

#: Where a finished clip can turn up in ComfyUI's history. `SaveVideo` reports
#: through a preview payload whose key has moved between releases, and all of
#: the forms carry the same `{filename, subfolder}` rows.
SAVED_KEYS = ("images", "video", "videos", "gifs", "animated")


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    prompt: str
    negative_prompt: str
    out_path: Path
    width: int
    height: int
    num_frames: int
    steps: int
    seed: int
    batch: int
    scheduler: str = graph_module.DEFAULT_SCHEDULER
    shift_video: float = graph_module.DEFAULT_SHIFT_VIDEO
    shift_audio: float = graph_module.DEFAULT_SHIFT_AUDIO
    keyframes: list[str] = field(default_factory=list)
    #: `fl2v` reads `keyframes` as a first and a last frame; `ref2v` reads them
    #: as `<Picture 1>` ... references the prompt cites.
    mode: str = graph_module.DEFAULT_MODE
    ref_image_size: str = graph_module.DEFAULT_REF_IMAGE_SIZE


@dataclass
class VideoOut:
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
    num_frames: int
    frame_rate: int
    videos: list[VideoOut]
    peak_vram_gib: float
    vram_scope: str
    stages: list[dict[str, Any]]
    mode: str = graph_module.DEFAULT_MODE
    #: Always the prompt as submitted. H3's own rewriter, H3-Context-IR, is a
    #: hosted service rather than part of the open release; the studio's
    #: enhancer runs on a separate arm before the job is sent, so by the time a
    #: prompt arrives here it is final. Reported so the library's record reads
    #: the same across arms.
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


def _float(body: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"{key} must be a number")
    number = float(value)
    if not low <= number <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return number


def _name(body: dict[str, Any], key: str, fallback: str) -> str:
    value = body.get(key)
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not NAME.match(value):
        raise JobError(f"{key} is not a scheduler name")
    return value


def _edge(body: dict[str, Any], key: str, default: int) -> int:
    value = _int(body, key, default, MIN_EDGE, MAX_EDGE)
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

    mode = body.get("mode") or graph_module.DEFAULT_MODE
    if mode not in graph_module.MODES:
        raise JobError(f"mode must be one of {', '.join(graph_module.MODES)}")

    ref_image_size = body.get("refImageSize") or graph_module.DEFAULT_REF_IMAGE_SIZE
    if ref_image_size not in graph_module.REF_IMAGE_SIZES:
        raise JobError(f"refImageSize must be one of {', '.join(graph_module.REF_IMAGE_SIZES)}")

    # `image` is the single-keyframe spelling the LTX arm takes, kept so a
    # caller that only knows that one still works. `refImages` is the image
    # console's. In fl2v it is positional -- first frame, then last frame; in
    # ref2v it is the order the prompt numbers its `<Picture i>` tags in.
    raw_refs = body.get("refImages")
    if raw_refs is None:
        single = body.get("image")
        raw_refs = [single] if isinstance(single, str) and single else []
    if not isinstance(raw_refs, list):
        raise JobError("refImages must be a list")
    if mode == "fl2v" and len(raw_refs) > MAX_KEYFRAMES:
        raise JobError(
            f"at most {MAX_KEYFRAMES} keyframes -- the fl2va checkpoint takes a first "
            "frame and a last frame, and nothing between them; several references are ref2v"
        )
    if mode == "ref2v" and not raw_refs:
        raise JobError("ref2v needs at least one reference image -- with none, it is fl2v")
    if mode == "ref2v" and len(raw_refs) > MAX_REFERENCES:
        raise JobError(f"at most {MAX_REFERENCES} reference images in ref2v")

    keyframes: list[str] = []
    for entry in raw_refs:
        if not isinstance(entry, str):
            raise JobError("every keyframe must be a path")
        resolved = _inside(in_dir, entry, "refImages")
        if not resolved.is_file():
            raise JobError(f"{'reference' if mode == 'ref2v' else 'keyframe'} {entry} is not there")
        keyframes.append(resolved.relative_to(in_dir.resolve()).as_posix())

    requested_frames = _int(body, "numFrames", graph_module.frames_for_seconds(5), 5, MAX_FRAMES)

    return Job(
        prompt=prompt.strip(),
        negative_prompt=negative.strip(),
        out_path=out_path,
        width=_edge(body, "width", 1344),
        height=_edge(body, "height", 768),
        # Rounded here rather than refused: the grid is the model's, the
        # console already rounds to it, and a caller that did not should get a
        # clip rather than a 400.
        num_frames=graph_module.align_frames(requested_frames),
        steps=_int(body, "steps", graph_module.DEFAULT_STEPS, graph_module.MIN_STEPS, MAX_STEPS),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        scheduler=_name(body, "scheduler", graph_module.DEFAULT_SCHEDULER),
        shift_video=_float(body, "flowShift", graph_module.DEFAULT_SHIFT_VIDEO, 0.01, 100.0),
        shift_audio=_float(body, "audioShift", graph_module.DEFAULT_SHIFT_AUDIO, 0.01, 100.0),
        keyframes=keyframes,
        mode=mode,
        ref_image_size=ref_image_size,
    )


def seeds_for(job: Job) -> list[int]:
    """One seed per clip, so each file is reproducible on its own."""
    if job.seed < 0:
        return [secrets.randbelow(RANDOM_SEED_CEILING) for _ in range(job.batch)]
    return [min(job.seed + index, MAX_SEED) for index in range(job.batch)]


def paths_for(job: Job) -> list[Path]:
    """Where a batch lands: `name.mp4`, then `name-2.mp4`, `name-3.mp4`."""
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [
        job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
        for index in range(job.batch)
    ]


def _saved_files(history: dict[str, Any]) -> list[dict[str, Any]]:
    """The rows `SaveVideo` filed, whichever key this ComfyUI put them under."""
    outputs = history.get("outputs")
    node = outputs.get(graph_module.SAVE) if isinstance(outputs, dict) else None
    if not isinstance(node, dict):
        return []
    for key in SAVED_KEYS:
        rows = node.get(key)
        if isinstance(rows, list) and rows:
            return [entry for entry in rows if isinstance(entry, dict) and entry.get("filename")]
    return []


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
    # Addressed to this arm's client id, because ComfyUI sends its `executing`
    # events to whoever queued the prompt and nowhere else.
    submitted = server.post(
        "/prompt", {"prompt": graph, "prompt_id": prompt_id, "client_id": server.client_id}
    )
    node_errors = submitted.get("node_errors") if isinstance(submitted, dict) else None
    if node_errors:
        raise ChildFailed(f"ComfyUI would not run the graph: {node_errors}")
    return _await_prompt(server, prompt_id)


def _collect(
    server: ComfyServer, entry: dict[str, Any], target: Path, index: int, seed: int
) -> VideoOut:
    """Move the one file this prompt produced out of ComfyUI's own output tree."""
    files = _saved_files(entry)
    if not files:
        raise ChildFailed("ComfyUI finished the prompt without saving a video")
    if len(files) > 1:
        raise ChildFailed(f"ComfyUI saved {len(files)} files for a single-clip prompt")

    saved = files[0]
    filename = str(saved["filename"])

    subfolder = saved.get("subfolder") or ""
    source = server.config.scratch_dir / "output"
    if subfolder:
        source = source / subfolder
    source = source / filename

    if not source.is_file():
        raise ChildFailed(f"ComfyUI said it wrote {source}, and it is not there")

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))

    return VideoOut(out_path=str(target), out_bytes=target.stat().st_size, index=index, seed=seed)


def _stages(progress: JobProgress) -> list[dict[str, Any]]:
    snapshot = progress.snapshot()
    for step in snapshot.get("steps", []):
        if step.get("key") == "generate":
            return [
                {
                    "name": child.get("label", child.get("key", "")),
                    "seconds": child.get("seconds", 0.0),
                }
                for child in step.get("children", [])
            ]
    return []


def generate(server: ComfyServer, models: Models, job: Job, progress: JobProgress) -> GenerationReport:
    started = time.perf_counter()

    seconds = job.num_frames / graph_module.FPS
    detail = f"{job.width}×{job.height} · {job.num_frames} frames ({seconds:.2f}s) · {job.steps} step"
    if job.batch > 1:
        detail += f" · ×{job.batch}"
    if job.mode == "ref2v":
        detail += f" · ref2v, {len(job.keyframes)} reference{'' if len(job.keyframes) == 1 else 's'}"
    elif job.keyframes:
        detail += " · first frame" if len(job.keyframes) == 1 else " · first and last frame"

    seeds = seeds_for(job)
    destinations = paths_for(job)
    written: list[VideoOut] = []

    with progress.step("generate", "Generate", detail) as reported:
        if job.batch > 1:
            progress.meter("batch", "Clips", job.batch)

        for index, (seed, target) in enumerate(zip(seeds, destinations, strict=True)):
            if job.batch > 1:
                progress.advance("batch", index, job.batch)
                reported.detail(f"{detail} · clip {index + 1} of {job.batch}")

            sampling = Sampling(
                prompt=job.prompt,
                negative_prompt=job.negative_prompt,
                width=job.width,
                height=job.height,
                num_frames=job.num_frames,
                steps=job.steps,
                seed=seed,
                scheduler=job.scheduler,
                shift_video=job.shift_video,
                shift_audio=job.shift_audio,
                keyframes=job.keyframes,
                mode=job.mode,
                ref_image_size=job.ref_image_size,
            )

            server.begin_scan(
                job.steps,
                phases=graph_module.PHASES,
                sampler_node=graph_module.SAMPLER,
            )
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
        num_frames=job.num_frames,
        frame_rate=graph_module.FPS,
        videos=written,
        peak_vram_gib=progress.peak_gib,
        vram_scope="unavailable",
        stages=_stages(progress),
        mode=job.mode,
        prompt_used=job.prompt,
    )

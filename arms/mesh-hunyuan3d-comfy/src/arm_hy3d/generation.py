"""One job: validate it, queue it a prompt at a time, and file what comes back.

The arm owns two things ComfyUI does not: where a file may be read from and
where it may be written to. Everything in `parse_job` exists because the job
payload arrives over HTTP from another process, and a path in it is a path
someone can choose.

The vocabulary is the image arm's wherever the two overlap -- `refImages`,
`outPath`, `seed`, `steps`, `cfgScale`, `batch` -- so the studio's routes build
both bodies the same way.
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import struct
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import graph as graph_module
from .graph import Models, Shape
from .progress import JobProgress
from .runtime import ChildFailed, ComfyServer

NAME = re.compile(r"^[a-z0-9_+.\-/]{1,40}$")

# A mesh is minutes of card time, not seconds, so the ceiling is lower than the
# image arm's hundred. It is a guard against a mistyped number.
MAX_BATCH = 8
MAX_STEPS = 100
#: The VAE's own octree ceiling is 512; above 384 the decode does not fit
#: alongside the DiT on a 16 GiB card.
OCTREE_CHOICES = (128, 192, 256, 320, 384)
LATENT_TOKEN_CHOICES = (1024, 2048, 3072, 4096)
#: Two million faces is already far past anything a browser should be sent.
MAX_FACES = 2_000_000
OUTPUT_FORMAT = "glb"
POLL_SECONDS = 0.4
JOB_TIMEOUT_SECONDS = 3600.0
RANDOM_SEED_CEILING = 2**31 - 1
MAX_SEED = 0xFFFFFFFFFFFFFFFF


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    out_path: Path
    #: The reference image, relative to ComfyUI's input directory.
    reference: str
    seed: int
    batch: int
    steps: int = graph_module.DEFAULT_STEPS
    cfg_scale: float = graph_module.DEFAULT_CFG
    sampler: str = graph_module.DEFAULT_SAMPLER
    scheduler: str = graph_module.DEFAULT_SCHEDULER
    octree: int = graph_module.DEFAULT_OCTREE
    latent_tokens: int = graph_module.DEFAULT_LATENT_TOKENS
    target_faces: int = 0
    remove_background: bool = True


@dataclass
class MeshOut:
    out_path: str
    out_bytes: int
    index: int
    seed: int
    #: Read back from the GLB itself, so the number is what was written rather
    #: than what was asked for -- decimation stops early on a small mesh.
    vertices: int | None
    faces: int | None


@dataclass
class GenerationReport:
    seconds_total: float
    steps: int
    seed: int
    batch: int
    meshes: list[MeshOut]
    peak_vram_gib: float
    vram_scope: str
    stages: list[dict[str, Any]]


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


def _choice(body: dict[str, Any], key: str, default: int, choices: tuple[int, ...]) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) not in choices:
        raise JobError(f"{key} must be one of {', '.join(str(choice) for choice in choices)}")
    return int(value)


def _name(body: dict[str, Any], key: str, fallback: str) -> str:
    value = body.get(key)
    if value is None or value == "":
        return fallback
    if not isinstance(value, str) or not NAME.match(value):
        raise JobError(f"{key} is not a sampler or scheduler name")
    return value


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path) -> Job:
    out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
    if out_path.suffix.lower() != f".{OUTPUT_FORMAT}":
        raise JobError(f"outPath must end in .{OUTPUT_FORMAT}")

    raw_refs = body.get("refImages") or []
    if not isinstance(raw_refs, list) or len(raw_refs) != 1:
        raise JobError("refImages must name exactly one image -- this arm is single-view")
    entry = raw_refs[0]
    if not isinstance(entry, str):
        raise JobError("the reference image must be a path")
    resolved = _inside(in_dir, entry, "refImages")
    if not resolved.is_file():
        raise JobError(f"reference image {entry} is not there")

    remove_background = body.get("removeBackground", True)
    if not isinstance(remove_background, bool):
        raise JobError("removeBackground must be true or false")

    return Job(
        out_path=out_path,
        reference=resolved.relative_to(in_dir.resolve()).as_posix(),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        steps=_int(body, "steps", graph_module.DEFAULT_STEPS, 1, MAX_STEPS),
        cfg_scale=_float(body, "cfgScale", graph_module.DEFAULT_CFG, 0.0, 30.0),
        sampler=_name(body, "sampler", graph_module.DEFAULT_SAMPLER),
        scheduler=_name(body, "scheduler", graph_module.DEFAULT_SCHEDULER),
        octree=_choice(body, "octreeResolution", graph_module.DEFAULT_OCTREE, OCTREE_CHOICES),
        latent_tokens=_choice(body, "latentTokens", graph_module.DEFAULT_LATENT_TOKENS, LATENT_TOKEN_CHOICES),
        target_faces=_int(body, "targetFaces", 0, 0, MAX_FACES),
        remove_background=remove_background,
    )


def seeds_for(job: Job) -> list[int]:
    """One seed per mesh, so each file is reproducible on its own."""
    if job.seed < 0:
        return [secrets.randbelow(RANDOM_SEED_CEILING) for _ in range(job.batch)]
    return [min(job.seed + index, MAX_SEED) for index in range(job.batch)]


def paths_for(job: Job) -> list[Path]:
    """`name.glb`, then `name-2.glb`, `name-3.glb` -- the image arm's rule."""
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [
        job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
        for index in range(job.batch)
    ]


def shape_for(job: Job, seed: int) -> Shape:
    return Shape(
        reference=job.reference,
        seed=seed,
        steps=job.steps,
        cfg=job.cfg_scale,
        sampler=job.sampler,
        scheduler=job.scheduler,
        latent_tokens=job.latent_tokens,
        octree=job.octree,
        target_faces=job.target_faces,
        remove_background=job.remove_background,
    )


def glb_counts(path: Path) -> tuple[int | None, int | None]:
    """Vertex and face counts from a GLB's JSON chunk, without a 3D library.

    The header is twelve bytes, then a chunk whose length and type come first;
    the counts are the accessors the first primitive points at. `None` for
    anything that does not read as a GLB -- this is a report, not a check.
    """
    try:
        with path.open("rb") as handle:
            header = handle.read(20)
            if len(header) < 20 or header[:4] != b"glTF":
                return None, None
            length, kind = struct.unpack("<II", header[12:20])
            if kind != 0x4E4F534A:  # "JSON"
                return None, None
            document = json.loads(handle.read(length))
    except (OSError, ValueError):
        return None, None

    accessors = document.get("accessors") or []
    vertices = faces = 0
    for mesh in document.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            position = (primitive.get("attributes") or {}).get("POSITION")
            if isinstance(position, int) and position < len(accessors):
                vertices += int(accessors[position].get("count") or 0)
            indices = primitive.get("indices")
            if isinstance(indices, int) and indices < len(accessors):
                faces += int(accessors[indices].get("count") or 0) // 3
    return (vertices or None), (faces or None)


def _saved_files(history: dict[str, Any]) -> list[dict[str, Any]]:
    """The files `SaveGLB` reported. It answers under `3d`, not `images`."""
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        return []
    node = outputs.get(graph_module.SAVE)
    files = node.get("3d") if isinstance(node, dict) else None
    return [entry for entry in files or [] if isinstance(entry, dict)]


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


def _collect(server: ComfyServer, entry: dict[str, Any], target: Path, index: int, seed: int) -> MeshOut:
    """Move the one GLB this prompt produced out of ComfyUI's own output tree."""
    files = _saved_files(entry)
    if not files:
        raise ChildFailed(
            "ComfyUI finished the prompt without saving a mesh -- "
            "an empty one is skipped, which usually means the cut-out found no object"
        )
    if len(files) > 1:
        raise ChildFailed(f"ComfyUI saved {len(files)} meshes for a single-mesh prompt")

    saved = files[0]
    filename = saved.get("filename")
    if not isinstance(filename, str) or not filename:
        raise ChildFailed("ComfyUI saved a mesh without naming it")

    subfolder = saved.get("subfolder") or ""
    source = server.config.scratch_dir / "output"
    if subfolder:
        source = source / subfolder
    source = source / filename

    if not source.is_file():
        raise ChildFailed(f"ComfyUI said it wrote {source}, and it is not there")

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))

    vertices, faces = glb_counts(target)
    return MeshOut(
        out_path=str(target),
        out_bytes=target.stat().st_size,
        index=index,
        seed=seed,
        vertices=vertices,
        faces=faces,
    )


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

    detail = f"{job.steps} step · cfg {job.cfg_scale:g} · octree {job.octree}"
    if job.target_faces:
        detail += f" · ≤{job.target_faces:,} faces"
    if job.batch > 1:
        detail += f" · ×{job.batch}"

    seeds = seeds_for(job)
    destinations = paths_for(job)
    written: list[MeshOut] = []

    with progress.step("generate", "Generate", detail) as reported:
        if job.batch > 1:
            progress.meter("batch", "Meshes", job.batch)

        for index, (seed, target) in enumerate(zip(seeds, destinations, strict=True)):
            if job.batch > 1:
                progress.advance("batch", index, job.batch)
                reported.detail(f"{detail} · mesh {index + 1} of {job.batch}")

            prompt_id = str(uuid.uuid4())
            graph = graph_module.build(models, shape_for(job, seed), f"aistudio/{prompt_id}")
            server.begin_scan(job.steps, prompt_id, graph_module.labels_for(graph))
            try:
                body = {
                    "prompt": graph,
                    "prompt_id": prompt_id,
                    # Events about this prompt go to the client that queued it;
                    # without this the arm's websocket would hear nothing.
                    "client_id": server.client_id,
                }
                submitted = server.post("/prompt", body)
                node_errors = submitted.get("node_errors") if isinstance(submitted, dict) else None
                if node_errors:
                    raise ChildFailed(f"ComfyUI would not run the graph: {node_errors}")

                entry = _await_prompt(server, prompt_id)
            finally:
                server.end_scan()

            written.append(_collect(server, entry, target, index, seed))

        if job.batch > 1:
            progress.advance("batch", len(written), job.batch)

        faces = written[-1].faces
        reported.detail(
            f"{detail} · {len(written)} file{'' if len(written) == 1 else 's'}"
            + (f" · {faces:,} faces" if faces else "")
        )

    return GenerationReport(
        seconds_total=time.perf_counter() - started,
        steps=job.steps,
        seed=written[0].seed,
        batch=job.batch,
        meshes=written,
        peak_vram_gib=progress.peak_gib,
        vram_scope="unavailable",
        stages=_stages(progress),
    )

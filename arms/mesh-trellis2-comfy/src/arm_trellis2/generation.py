"""One job: validate it, queue it a prompt at a time, and file what comes back.

The arm owns two things ComfyUI does not: where a file may be read from and
where it may be written to. Everything in `parse_job` exists because the job
payload arrives over HTTP from another process, and a path in it is a path
someone can choose.

The vocabulary is the image arm's wherever the two overlap -- `refImages`,
`outPath`, `seed`, `cfgScale`, `batch`, `targetFaces`, `removeBackground` -- and
the Hunyuan3D mesh arm's where they are both mesh arms, so the studio's routes
build every body the same way.
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
from .webp import compress_textures

# A mesh is minutes of card time, not seconds, so the ceiling is lower than the
# image arm's hundred. It is a guard against a mistyped number.
MAX_BATCH = 8
MAX_STEPS = 100
#: A mesh needs faces to carry a texture, and two million is already far past
#: anything a browser should be sent.
MIN_FACES = 1_000
MAX_FACES = 2_000_000
TEXTURE_SIZES = (512, 1024, 2048, 4096)
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
    structure_steps: int = graph_module.DEFAULT_STRUCTURE_STEPS
    shape_steps: int = graph_module.DEFAULT_SHAPE_STEPS
    refine_steps: int = graph_module.DEFAULT_REFINE_STEPS
    texture_steps: int = graph_module.DEFAULT_TEXTURE_STEPS
    cfg_scale: float = graph_module.DEFAULT_CFG
    shape_resolution: int = graph_module.DEFAULT_SHAPE_RESOLUTION
    target_faces: int = graph_module.DEFAULT_TARGET_FACES
    texture_size: int = graph_module.DEFAULT_TEXTURE_SIZE
    bake_normals: bool = True
    bake_occlusion: bool = True
    remove_background: bool = True
    #: Re-encode the baked maps as WebP once the GLB is written.
    compress_textures: bool = True
    #: WebP quality, 1-100; 100 is lossless.
    texture_quality: int = 100

    @property
    def steps(self) -> int:
        """Every sampler step the job runs, which is what the step meter counts."""
        return self.structure_steps + self.shape_steps + self.refine_steps + self.texture_steps


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
    #: Whether the GLB carries an image -- the point of this arm.
    textured: bool
    #: Bytes the texture maps took before and after WebP; both 0 when the
    #: maps were left as ComfyUI wrote them.
    texture_bytes_before: int = 0
    texture_bytes_after: int = 0


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


def _bool(body: dict[str, Any], key: str, default: bool) -> bool:
    value = body.get(key, default)
    if not isinstance(value, bool):
        raise JobError(f"{key} must be true or false")
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

    return Job(
        out_path=out_path,
        reference=resolved.relative_to(in_dir.resolve()).as_posix(),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        structure_steps=_int(body, "structureSteps", graph_module.DEFAULT_STRUCTURE_STEPS, 1, MAX_STEPS),
        shape_steps=_int(body, "shapeSteps", graph_module.DEFAULT_SHAPE_STEPS, 1, MAX_STEPS),
        refine_steps=_int(body, "refineSteps", graph_module.DEFAULT_REFINE_STEPS, 1, MAX_STEPS),
        texture_steps=_int(body, "textureSteps", graph_module.DEFAULT_TEXTURE_STEPS, 1, MAX_STEPS),
        cfg_scale=_float(body, "cfgScale", graph_module.DEFAULT_CFG, 0.0, 30.0),
        shape_resolution=_choice(
            body, "shapeResolution", graph_module.DEFAULT_SHAPE_RESOLUTION, graph_module.SHAPE_RESOLUTIONS
        ),
        target_faces=_int(body, "targetFaces", graph_module.DEFAULT_TARGET_FACES, MIN_FACES, MAX_FACES),
        texture_size=_choice(body, "textureSize", graph_module.DEFAULT_TEXTURE_SIZE, TEXTURE_SIZES),
        bake_normals=_bool(body, "bakeNormals", True),
        bake_occlusion=_bool(body, "bakeOcclusion", True),
        remove_background=_bool(body, "removeBackground", True),
        compress_textures=_bool(body, "compressTextures", True),
        texture_quality=_int(body, "textureQuality", 100, 1, 100),
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
        structure_steps=job.structure_steps,
        shape_steps=job.shape_steps,
        refine_steps=job.refine_steps,
        texture_steps=job.texture_steps,
        cfg=job.cfg_scale,
        shape_resolution=job.shape_resolution,
        target_faces=job.target_faces,
        texture_size=job.texture_size,
        bake_normals=job.bake_normals,
        bake_occlusion=job.bake_occlusion,
        remove_background=job.remove_background,
    )


def glb_counts(path: Path) -> tuple[int | None, int | None, bool]:
    """Vertex and face counts, and whether there is an image, from a GLB's JSON chunk.

    The header is twelve bytes, then a chunk whose length and type come first;
    the counts are the accessors the first primitive points at. `None` for
    anything that does not read as a GLB -- this is a report, not a check.
    """
    try:
        with path.open("rb") as handle:
            header = handle.read(20)
            if len(header) < 20 or header[:4] != b"glTF":
                return None, None, False
            length, kind = struct.unpack("<II", header[12:20])
            if kind != 0x4E4F534A:  # "JSON"
                return None, None, False
            document = json.loads(handle.read(length))
    except (OSError, ValueError):
        return None, None, False

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
    return (vertices or None), (faces or None), bool(document.get("images"))


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

    vertices, faces, textured = glb_counts(target)
    return MeshOut(
        out_path=str(target),
        out_bytes=target.stat().st_size,
        index=index,
        seed=seed,
        vertices=vertices,
        faces=faces,
        textured=textured,
    )


def _compress(mesh: MeshOut, progress: JobProgress, index: int, quality: int) -> None:
    """WebP the maps of a written GLB, as a step of its own on the timeline.

    After the file is in the library's tree rather than in ComfyUI's, so a
    failure here leaves a working, larger GLB instead of no GLB at all.
    """
    key = f"compress:{index}"
    how = "WebP lossless" if quality >= 100 else f"WebP q{quality}"
    progress.start(key, "Compress textures", how, parent="generate")
    target = Path(mesh.out_path)
    try:
        report = compress_textures(target, quality)
    except Exception as error:  # noqa: BLE001 - an uncompressed mesh is still a mesh
        progress.finish_step(key, detail=f"skipped: {type(error).__name__}: {error}")
        return
    mesh.out_bytes = target.stat().st_size
    mesh.texture_bytes_before = report.bytes_before
    mesh.texture_bytes_after = report.bytes_after
    saved = report.bytes_before - report.bytes_after
    progress.finish_step(
        key,
        detail=(
            f"{how} · {report.images} maps · "
            f"{report.bytes_before / 2**20:.1f} → {report.bytes_after / 2**20:.1f} MiB"
            + (f" (−{saved / max(report.bytes_before, 1):.0%})" if report.bytes_before else "")
        ),
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

    detail = f"shape {job.shape_resolution} · ≤{job.target_faces:,} faces · {job.texture_size}px texture"
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

            mesh = _collect(server, entry, target, index, seed)
            if job.compress_textures and mesh.textured:
                _compress(mesh, progress, index, job.texture_quality)
            written.append(mesh)

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

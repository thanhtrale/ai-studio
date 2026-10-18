"""One job: validate it, queue it a prompt at a time, and file what comes back.

The arm owns two things ComfyUI does not: where a file may be read from and
where it may be written to. Everything in `parse_job` exists because the job
payload arrives over HTTP from another process, and a path in it is a path
someone can choose.

The vocabulary is the TRELLIS.2 arm's wherever the two overlap -- `outPath`,
`seed`, `batch`, `targetFaces`, `textureSize`, the step counts -- with one
difference that is the point of this arm: the input is `views`, a view name per
image, rather than one `refImages` entry.

Beside each mesh the arm leaves what a reviewer needs to trace a bad one back
to its cause:

    <name>.glb
    <name>_views/<view>.png    each view after the cut-out and crop -- what the model saw
    <name>_basecolor.png       the baked colour atlas
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import struct
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import graph as graph_module
from .graph import VIEW_NAMES, Models, Shape
from .progress import JobProgress
from .runtime import ChildFailed, ComfyServer
from .webp import compress_textures

# A mesh is minutes of card time, not seconds, so the ceiling is low. It is a
# guard against a mistyped number.
MAX_BATCH = 8
MAX_STEPS = 100
MIN_FACES = 20_000
MAX_FACES = 2_000_000
TEXTURE_SIZES = (512, 1024, 2048, 4096)
OUTPUT_FORMAT = "glb"
POLL_SECONDS = 0.4
JOB_TIMEOUT_SECONDS = 3600.0
RANDOM_SEED_CEILING = 2**31 - 100
MAX_SEED = 0xFFFFFFFFFFFFFFFF


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    out_path: Path
    #: View name -> image, relative to ComfyUI's input directory.
    views: dict[str, str]
    seed: int
    batch: int
    structure_steps: int = graph_module.DEFAULT_STRUCTURE_STEPS
    shape_steps: int = graph_module.DEFAULT_SHAPE_STEPS
    refine_steps: int = graph_module.DEFAULT_REFINE_STEPS
    texture_steps: int = graph_module.DEFAULT_TEXTURE_STEPS
    structure_cfg: float = graph_module.DEFAULT_CFG
    shape_cfg: float = graph_module.DEFAULT_CFG
    shape_resolution: int = graph_module.DEFAULT_SHAPE_RESOLUTION
    remesh_resolution: int = graph_module.DEFAULT_REMESH_RESOLUTION
    target_faces: int = graph_module.DEFAULT_TARGET_FACES
    texture_size: int = graph_module.DEFAULT_TEXTURE_SIZE
    fov: float = graph_module.DEFAULT_FOV
    pad: float = graph_module.DEFAULT_PAD
    drop_inverted: bool = False
    drop_enclosed: bool = False
    bake_normals: bool = True
    bake_occlusion: bool = True
    #: Re-encode the baked maps as WebP once the GLB is written. Off when the
    #: mesh goes on to `reproject.py` or the rig: trimesh drops EXT_texture_webp.
    compress_textures: bool = True
    texture_quality: int = 100

    @property
    def steps(self) -> int:
        """Every sampler step the job runs, which is what the step meter counts."""
        return self.structure_steps + self.shape_steps + self.refine_steps + self.texture_steps

    @property
    def multi(self) -> bool:
        return len(self.views) > 1


@dataclass
class MeshOut:
    out_path: str
    out_bytes: int
    index: int
    seed: int
    #: Read back from the GLB itself, so the number is what was written.
    vertices: int | None
    faces: int | None
    textured: bool
    #: View name -> the cut-out the model was conditioned on.
    views: dict[str, str] = field(default_factory=dict)
    basecolor: str | None = None
    texture_bytes_before: int = 0
    texture_bytes_after: int = 0


@dataclass
class GenerationReport:
    seconds_total: float
    steps: int
    seed: int
    batch: int
    #: `multi-view` or `single-view`, and which transformer file that meant.
    mode: str
    model: str
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


def _views(body: dict[str, Any], in_dir: Path) -> dict[str, str]:
    raw = body.get("views")
    if not isinstance(raw, dict) or not raw:
        raise JobError("views must map a view name (front, left, back, right) to an image")
    unknown = sorted(set(raw) - set(VIEW_NAMES))
    if unknown:
        raise JobError(f"unknown view {', '.join(unknown)} -- the rig has front, left, back and right")
    if not raw.get("front"):
        raise JobError("views.front is required")

    views: dict[str, str] = {}
    for name in VIEW_NAMES:
        entry = raw.get(name)
        if entry is None:
            continue
        if not isinstance(entry, str):
            raise JobError(f"views.{name} must be a path")
        resolved = _inside(in_dir, entry, f"views.{name}")
        if not resolved.is_file():
            raise JobError(f"views.{name} ({entry}) is not there")
        views[name] = resolved.relative_to(in_dir.resolve()).as_posix()
    return views


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path) -> Job:
    out_path = _inside(out_dir, str(body.get("outPath") or ""), "outPath")
    if out_path.suffix.lower() != f".{OUTPUT_FORMAT}":
        raise JobError(f"outPath must end in .{OUTPUT_FORMAT}")

    return Job(
        out_path=out_path,
        views=_views(body, in_dir),
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        structure_steps=_int(body, "structureSteps", graph_module.DEFAULT_STRUCTURE_STEPS, 4, MAX_STEPS),
        shape_steps=_int(body, "shapeSteps", graph_module.DEFAULT_SHAPE_STEPS, 4, MAX_STEPS),
        refine_steps=_int(body, "refineSteps", graph_module.DEFAULT_REFINE_STEPS, 4, MAX_STEPS),
        texture_steps=_int(body, "textureSteps", graph_module.DEFAULT_TEXTURE_STEPS, 4, MAX_STEPS),
        structure_cfg=_float(body, "structureCfg", graph_module.DEFAULT_CFG, 1.0, 15.0),
        shape_cfg=_float(body, "shapeCfg", graph_module.DEFAULT_CFG, 1.0, 15.0),
        shape_resolution=_choice(
            body, "shapeResolution", graph_module.DEFAULT_SHAPE_RESOLUTION, graph_module.SHAPE_RESOLUTIONS
        ),
        remesh_resolution=_int(body, "remeshResolution", graph_module.DEFAULT_REMESH_RESOLUTION, 256, 1024),
        target_faces=_int(body, "targetFaces", graph_module.DEFAULT_TARGET_FACES, MIN_FACES, MAX_FACES),
        texture_size=_choice(body, "textureSize", graph_module.DEFAULT_TEXTURE_SIZE, TEXTURE_SIZES),
        fov=_float(body, "fov", graph_module.DEFAULT_FOV, 1.0, 170.0),
        pad=_float(body, "pad", graph_module.DEFAULT_PAD, 1.0, 1.5),
        drop_inverted=_bool(body, "dropInverted", False),
        drop_enclosed=_bool(body, "dropEnclosed", False),
        bake_normals=_bool(body, "bakeNormals", True),
        bake_occlusion=_bool(body, "bakeOcclusion", True),
        compress_textures=_bool(body, "compressTextures", True),
        texture_quality=_int(body, "textureQuality", 100, 1, 100),
    )


def seeds_for(job: Job) -> list[int]:
    """One seed per mesh, so each file is reproducible on its own.

    Random by default, and on purpose: on the character pipeline the seed
    decides the face, the hair colour and how well the mesh rigs, and the
    only working strategy measured was to try several and keep the best.
    """
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
        views=dict(job.views),
        seed=seed,
        structure_steps=job.structure_steps,
        shape_steps=job.shape_steps,
        refine_steps=job.refine_steps,
        texture_steps=job.texture_steps,
        structure_cfg=job.structure_cfg,
        shape_cfg=job.shape_cfg,
        shape_resolution=job.shape_resolution,
        remesh_resolution=job.remesh_resolution,
        target_faces=job.target_faces,
        texture_size=job.texture_size,
        fov=job.fov,
        pad=job.pad,
        drop_inverted=job.drop_inverted,
        drop_enclosed=job.drop_enclosed,
        bake_normals=job.bake_normals,
        bake_occlusion=job.bake_occlusion,
    )


def glb_counts(path: Path) -> tuple[int | None, int | None, bool]:
    """Vertex and face counts, and whether there is an image, from a GLB's JSON chunk."""
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


def _outputs(history: dict[str, Any], node: str, kind: str) -> list[dict[str, Any]]:
    """The files one save node reported. `SaveGLB` answers under `3d`, `SaveImage` under `images`."""
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        return []
    entry = outputs.get(node)
    files = entry.get(kind) if isinstance(entry, dict) else None
    return [item for item in files or [] if isinstance(item, dict)]


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


def _source(server: ComfyServer, saved: dict[str, Any], what: str) -> Path:
    filename = saved.get("filename")
    if not isinstance(filename, str) or not filename:
        raise ChildFailed(f"ComfyUI saved {what} without naming it")
    source = server.config.scratch_dir / "output"
    subfolder = saved.get("subfolder") or ""
    if subfolder:
        source = source / subfolder
    source = source / filename
    if not source.is_file():
        raise ChildFailed(f"ComfyUI said it wrote {source}, and it is not there")
    return source


def _collect(
    server: ComfyServer, entry: dict[str, Any], job: Job, target: Path, index: int, seed: int
) -> MeshOut:
    """Move this prompt's GLB, its view cut-outs and its atlas out of ComfyUI's own output tree."""
    meshes = _outputs(entry, graph_module.SAVE, "3d")
    if not meshes:
        raise ChildFailed(
            "ComfyUI finished the prompt without saving a mesh -- "
            "an empty one is skipped, which usually means the cut-out found no object"
        )
    if len(meshes) > 1:
        raise ChildFailed(f"ComfyUI saved {len(meshes)} meshes for a single-mesh prompt")

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(_source(server, meshes[0], "a mesh")), str(target))

    views: dict[str, str] = {}
    views_dir = target.with_name(f"{target.stem}_views")
    for name in job.views:
        for saved in _outputs(entry, graph_module.view_node("save_view", name), "images")[:1]:
            views_dir.mkdir(exist_ok=True)
            dest = views_dir / f"{name}.png"
            shutil.move(str(_source(server, saved, f"the {name} view")), str(dest))
            views[name] = str(dest)

    basecolor = None
    for saved in _outputs(entry, graph_module.SAVE_BASECOLOR, "images")[:1]:
        dest = target.with_name(f"{target.stem}_basecolor.png")
        shutil.move(str(_source(server, saved, "the colour atlas")), str(dest))
        basecolor = str(dest)

    vertices, faces, textured = glb_counts(target)
    return MeshOut(
        out_path=str(target),
        out_bytes=target.stat().st_size,
        index=index,
        seed=seed,
        vertices=vertices,
        faces=faces,
        textured=textured,
        views=views,
        basecolor=basecolor,
    )


def _compress(mesh: MeshOut, progress: JobProgress, index: int, quality: int) -> None:
    """WebP the maps of a written GLB, as a step of its own on the timeline."""
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
    progress.finish_step(
        key,
        detail=(
            f"{how} · {report.images} maps · "
            f"{report.bytes_before / 2**20:.1f} → {report.bytes_after / 2**20:.1f} MiB"
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

    mode = "multi-view" if job.multi else "single-view"
    model = models.multiview_model if job.multi else models.single_model
    detail = (
        f"{mode} ({', '.join(job.views)}) · shape {job.shape_resolution} · "
        f"≤{job.target_faces:,} faces · {job.texture_size}px texture"
    )
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
                body = {"prompt": graph, "prompt_id": prompt_id, "client_id": server.client_id}
                submitted = server.post("/prompt", body)
                node_errors = submitted.get("node_errors") if isinstance(submitted, dict) else None
                if node_errors:
                    raise ChildFailed(f"ComfyUI would not run the graph: {node_errors}")

                entry = _await_prompt(server, prompt_id)
            finally:
                server.end_scan()

            mesh = _collect(server, entry, job, target, index, seed)
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
        mode=mode,
        model=model,
        meshes=written,
        peak_vram_gib=progress.peak_gib,
        vram_scope="unavailable",
        stages=_stages(progress),
    )

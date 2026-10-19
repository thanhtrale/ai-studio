"""One job: validate it, run shape then paint per seed, and file what comes back.

The vocabulary is the other mesh arms' -- `refImages`, `outPath`, `seed`,
`batch`, `steps`, `cfgScale`, `octreeResolution`, `targetFaces`,
`textureSize`, `removeBackground`, `compressTextures`, `textureQuality` -- so
the studio's route builds every body the same way. What is this arm's own is
the paint stage's handful (`texture`, `paintViews`, `paintResolution`,
`paintSteps`, `paintGuidance`, `upscale`), `meshPath`, which paints a mesh
that already exists instead of making one, and `refViews`, which makes the
shape from several views of the subject instead of one photo.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from PIL import Image

from .engine import Engine, PaintParams, ShapeParams, simplify
from .glb import TexturedMesh, write_glb
from .progress import JobProgress
from .webp import compress_textures

MAX_BATCH = 4
MAX_STEPS = 100
MIN_FACES = 5_000
MAX_FACES = 300_000
OCTREES = (128, 192, 256, 320, 384)
VIEW_COUNTS = (6, 7, 8, 9)
PAINT_RESOLUTIONS = (512, 768)
TEXTURE_SIZES = (1024, 2048, 4096)
#: Hunyuan3D-2mv's view slots. "left" is the subject turned 90 degrees clockwise
#: seen from above -- it faces the left edge of the picture, so its right side
#: shows; "right" is the mirror of that.
VIEW_NAMES = ("front", "left", "back", "right")
RANDOM_SEED_CEILING = 2**31 - 1
MAX_SEED = 0xFFFFFFFFFFFFFFFF
#: Tencent's pipeline puts the photograph's own viewpoint at +Z, which is where
#: glTF -- and three.js -- put the camera: a character shot from the front
#: comes out facing +Z, a chair shot at three-quarters comes out at that
#: three-quarter turn. So nothing is turned. (ComfyUI's port of the same model
#: faces +X instead; that arm turned it -90 degrees, and this one copied the
#: turn until a front-on character came out side-on.)
FRONT_YAW = 0.0


class JobError(ValueError):
    """The job as submitted cannot be run. Answered as 400, not 500."""


@dataclass
class Job:
    out_path: Path
    reference: Path
    seed: int
    batch: int
    steps: int = 30
    cfg_scale: float = 5.0
    octree: int = 256
    target_faces: int = 40_000
    remove_background: bool = True
    texture: bool = True
    paint_views: int = 6
    paint_resolution: int = 512
    paint_steps: int = 15
    paint_guidance: float = 3.0
    texture_size: int = 2048
    upscale: bool = True
    #: paint the head from the front reference itself (see Engine._project_face)
    project_face: bool = False
    compress_textures: bool = True
    texture_quality: int = 100
    #: A GLB to paint instead of a shape to make.
    mesh_path: Path | None = None
    #: {view: image} for the multi-view shape model; `reference` is then the front.
    views: dict[str, Path] = field(default_factory=dict)
    #: a high-resolution close-up of the face, merged into the head projection
    face_image: Path | None = None


@dataclass
class MeshOut:
    out_path: str
    out_bytes: int
    index: int
    seed: int
    vertices: int | None
    faces: int | None
    textured: bool
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
    stages: list[dict[str, Any]] = field(default_factory=list)


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
    if out_path.suffix.lower() != ".glb":
        raise JobError("outPath must end in .glb")

    views: dict[str, Path] = {}
    raw_views = body.get("refViews")
    if raw_views not in (None, {}):
        if not isinstance(raw_views, dict):
            raise JobError("refViews must be an object of view name to image path")
        for name, entry in raw_views.items():
            if name not in VIEW_NAMES:
                raise JobError(f"refViews keys are {', '.join(VIEW_NAMES)}, not {name!r}")
            if not isinstance(entry, str):
                raise JobError(f"refViews.{name} must be a path")
            path = _inside(in_dir, entry, f"refViews.{name}")
            if not path.is_file():
                raise JobError(f"refViews.{name} {entry} is not there")
            views[name] = path
        if "front" not in views or len(views) < 2:
            raise JobError("refViews needs a front view and at least one other")

    raw_refs = body.get("refImages") or []
    if views and not raw_refs:
        reference = views["front"]
    else:
        if not isinstance(raw_refs, list) or len(raw_refs) != 1 or not isinstance(raw_refs[0], str):
            raise JobError("refImages must name exactly one image; several views go in refViews")
        reference = _inside(in_dir, raw_refs[0], "refImages")
        if not reference.is_file():
            raise JobError(f"reference image {raw_refs[0]} is not there")

    mesh_path: Path | None = None
    raw_mesh = body.get("meshPath")
    if raw_mesh not in (None, ""):
        if not isinstance(raw_mesh, str):
            raise JobError("meshPath must be a path")
        mesh_path = _inside(in_dir, raw_mesh, "meshPath")
        if mesh_path.suffix.lower() != ".glb" or not mesh_path.is_file():
            raise JobError(f"meshPath {raw_mesh} is not a GLB that exists")

    face_image: Path | None = None
    raw_face = body.get("faceImage")
    if raw_face not in (None, ""):
        if not isinstance(raw_face, str):
            raise JobError("faceImage must be a path")
        face_image = _inside(in_dir, raw_face, "faceImage")
        if not face_image.is_file():
            raise JobError(f"faceImage {raw_face} is not there")

    job = Job(
        out_path=out_path,
        reference=reference,
        seed=_int(body, "seed", -1, -1, RANDOM_SEED_CEILING),
        batch=_int(body, "batch", 1, 1, MAX_BATCH),
        steps=_int(body, "steps", 30, 1, MAX_STEPS),
        cfg_scale=_float(body, "cfgScale", 5.0, 0.0, 30.0),
        octree=_choice(body, "octreeResolution", 256, OCTREES),
        target_faces=_int(body, "targetFaces", 40_000, MIN_FACES, MAX_FACES),
        remove_background=_bool(body, "removeBackground", True),
        texture=_bool(body, "texture", True),
        paint_views=_choice(body, "paintViews", 6, VIEW_COUNTS),
        paint_resolution=_choice(body, "paintResolution", 512, PAINT_RESOLUTIONS),
        paint_steps=_int(body, "paintSteps", 15, 1, 50),
        paint_guidance=_float(body, "paintGuidance", 3.0, 1.0, 10.0),
        texture_size=_choice(body, "textureSize", 2048, TEXTURE_SIZES),
        upscale=_bool(body, "upscale", True),
        project_face=_bool(body, "projectFace", False),
        compress_textures=_bool(body, "compressTextures", True),
        texture_quality=_int(body, "textureQuality", 100, 1, 100),
        mesh_path=mesh_path,
        views=views,
        face_image=face_image,
    )
    if job.face_image is not None and not job.project_face:
        raise JobError("faceImage is used by projectFace; set projectFace too")
    if job.mesh_path is not None and job.views:
        raise JobError("meshPath paints an existing mesh; refViews would be ignored")
    if job.mesh_path is not None and not job.texture:
        raise JobError("meshPath without texture would only copy the mesh")
    if job.mesh_path is not None and job.batch > 1:
        # A batch is one mesh per seed; with a given mesh the seed only
        # changes the paint, which is still a fair thing to want -- but one
        # at a time keeps the files' meaning obvious.
        raise JobError("meshPath paints one mesh; batch must be 1")
    return job


def seeds_for(job: Job) -> list[int]:
    if job.seed < 0:
        return [secrets.randbelow(RANDOM_SEED_CEILING) for _ in range(job.batch)]
    return [min(job.seed + index, MAX_SEED) for index in range(job.batch)]


def paths_for(job: Job) -> list[Path]:
    if job.batch == 1:
        return [job.out_path]
    stem, suffix = job.out_path.stem, job.out_path.suffix
    return [
        job.out_path if index == 0 else job.out_path.with_name(f"{stem}-{index + 1}{suffix}")
        for index in range(job.batch)
    ]


def _yaw(degrees: float) -> np.ndarray:
    return trimesh.transformations.rotation_matrix(np.radians(degrees), [0, 1, 0])


def load_input_mesh(path: Path) -> trimesh.Trimesh:
    """A library GLB, as one mesh in Hunyuan3D's own frame."""
    loaded = trimesh.load(str(path), force="mesh", process=False)
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        raise JobError(f"{path.name} holds no triangles")
    mesh = trimesh.Trimesh(loaded.vertices, loaded.faces, process=True)
    mesh.apply_transform(_yaw(-FRONT_YAW))
    return mesh


def _write_untextured(mesh: trimesh.Trimesh, path: Path) -> None:
    mesh = mesh.copy()
    mesh.apply_transform(_yaw(FRONT_YAW))
    vertices = np.asarray(mesh.vertices, dtype=np.float32)
    write_glb(
        TexturedMesh(
            positions=vertices,
            normals=np.asarray(mesh.vertex_normals, dtype=np.float32),
            uvs=np.zeros((len(vertices), 2), dtype=np.float32),
            faces=np.asarray(mesh.faces, dtype=np.uint32),
        ),
        path,
    )


def _write_textured(painted: TexturedMesh, path: Path) -> None:
    rotation = _yaw(FRONT_YAW)[:3, :3].astype(np.float32)
    painted.positions = painted.positions @ rotation.T
    painted.normals = painted.normals @ rotation.T
    write_glb(painted, path)


def _stages(progress: JobProgress) -> list[dict[str, Any]]:
    for step in progress.snapshot().get("steps", []):
        if step.get("key") == "generate":
            return [
                {"name": child.get("label", child.get("key", "")), "seconds": child.get("seconds", 0.0)}
                for child in step.get("children", [])
            ]
    return []


LABELS = {
    "cutout": "Cut out the object",
    "shape": "Sample shape",
    "clean": "Clean & decimate",
    "unwrap": "Unwrap UVs",
    "views": "Pick views, render normals & positions",
    "diffuse": "Paint views (albedo + MR)",
    "upscale": "Upscale views (Real-ESRGAN x4)",
    "bake": "Bake onto the UV map",
    "face": "Project the front view onto the head",
    "inpaint": "Inpaint unseen texels",
    "write": "Write GLB",
}


def generate(engine: Engine, job: Job, progress: JobProgress) -> GenerationReport:
    started = time.perf_counter()
    seeds = seeds_for(job)
    destinations = paths_for(job)
    written: list[MeshOut] = []

    detail = (
        f"paint {job.mesh_path.name}"
        if job.mesh_path is not None
        else f"octree {job.octree} · ≤{job.target_faces:,} faces"
    )
    if job.views:
        detail += f" · {len(job.views)} views ({', '.join(job.views)})"
    if job.texture:
        detail += f" · {job.paint_views} views · {job.texture_size}px"
    if job.batch > 1:
        detail += f" · ×{job.batch}"

    with progress.step("generate", "Generate", detail) as reported:
        if job.batch > 1:
            progress.meter("batch", "Meshes", job.batch)

        photo = Image.open(job.reference)
        photo.load()
        cut: Image.Image | None = None
        shape_input: Image.Image | dict[str, Image.Image] | None = None

        for index, (seed, target) in enumerate(zip(seeds, destinations, strict=True)):
            if job.batch > 1:
                progress.advance("batch", index, job.batch)
                reported.detail(f"{detail} · mesh {index + 1} of {job.batch}")
            suffix = f":{index}" if job.batch > 1 else ""

            def key(name: str, suffix: str = suffix) -> str:
                return f"{name}{suffix}"

            if cut is None:
                if job.remove_background or photo.mode != "RGBA":
                    with progress.step(
                        key("cutout"), LABELS["cutout"], engine.paths.rembg_model, parent="generate"
                    ):
                        cut = engine.cut_out(photo)
                else:
                    cut = photo.convert("RGBA")
                shape_input = cut
                if job.views:
                    shape_input = {}
                    for name in VIEW_NAMES:
                        if name not in job.views:
                            continue
                        if name == "front" and job.views[name] == job.reference:
                            shape_input[name] = cut
                            continue
                        view = Image.open(job.views[name])
                        view.load()
                        if job.remove_background or view.mode != "RGBA":
                            with progress.step(
                                key(f"cutout-{name}"), f"Cut out the {name} view", parent="generate"
                            ):
                                view = engine.cut_out(view)
                        shape_input[name] = view.convert("RGBA")

            if job.mesh_path is not None:
                with progress.step(key("clean"), "Load mesh", job.mesh_path.name, parent="generate") as step:
                    mesh = load_input_mesh(job.mesh_path)
                    before = len(mesh.faces)
                    mesh = simplify(mesh, job.target_faces)
                    step.detail(f"faces: {before:,} → {len(mesh.faces):,}")
            else:
                progress.start(
                    key("shape"), LABELS["shape"], f"{job.steps} steps · seed {seed}", parent="generate"
                )
                meter = key("shape-steps")
                progress.meter(meter, LABELS["shape"], job.steps)

                def shape_step(done: int, total: int, meter: str = meter) -> None:
                    progress.advance(meter, done, total)

                mesh = engine.make_shape(
                    shape_input,
                    ShapeParams(seed=seed, steps=job.steps, guidance=job.cfg_scale, octree=job.octree),
                    shape_step,
                )
                progress.finish_step(key("shape"), detail=f"{len(mesh.faces):,} faces raw")

                with progress.step(key("clean"), LABELS["clean"], parent="generate") as step:
                    before = len(mesh.faces)
                    mesh = simplify(mesh, job.target_faces)
                    step.detail(f"faces: {before:,} → {len(mesh.faces):,}")

            if job.texture:
                meter = key("paint-steps")
                progress.meter(meter, LABELS["diffuse"], job.paint_steps)

                def hook(event: str, name: str, text: str | None) -> None:
                    if event == "start":
                        progress.start(key(name), LABELS[name], text, parent="generate")
                    else:
                        progress.finish_step(key(name), detail=text)

                def paint_step(done: int, total: int, meter: str = meter) -> None:
                    progress.advance(meter, done, total)
                    progress.describe(key("diffuse"), f"{done}/{total}")

                painted = engine.paint_mesh(
                    mesh,
                    cut,
                    PaintParams(
                        views=job.paint_views,
                        resolution=job.paint_resolution,
                        steps=job.paint_steps,
                        guidance=job.paint_guidance,
                        texture_size=job.texture_size,
                        upscale=job.upscale,
                        project_face=job.project_face,
                    ),
                    seed,
                    hook,
                    paint_step,
                    face=Image.open(job.face_image) if job.face_image is not None else None,
                )
                with progress.step(key("write"), LABELS["write"], parent="generate"):
                    _write_textured(painted, target)
                vertices, faces = len(painted.positions), len(painted.faces)
            else:
                with progress.step(key("write"), LABELS["write"], parent="generate"):
                    _write_untextured(mesh, target)
                vertices, faces = len(mesh.vertices), len(mesh.faces)

            out = MeshOut(
                out_path=str(target),
                out_bytes=target.stat().st_size,
                index=index,
                seed=seed,
                vertices=vertices,
                faces=faces,
                textured=job.texture,
            )
            if job.texture and job.compress_textures:
                _compress(out, progress, key("compress"), job.texture_quality)
            written.append(out)

        if job.batch > 1:
            progress.advance("batch", len(written), job.batch)
        reported.detail(f"{detail} · {len(written)} file{'' if len(written) == 1 else 's'}")

    return GenerationReport(
        seconds_total=time.perf_counter() - started,
        steps=job.steps + (job.paint_steps if job.texture else 0),
        seed=written[0].seed,
        batch=job.batch,
        meshes=written,
        peak_vram_gib=progress.peak_gib,
        vram_scope="process",
        stages=_stages(progress),
    )


def _compress(mesh: MeshOut, progress: JobProgress, key: str, quality: int) -> None:
    """WebP the maps of a written GLB. A failure leaves the PNG GLB in place."""
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

"""Hunyuan3D 2.1, shape and paint, held in this process.

Two models that never run at once and do not fit on a 16 GB card together:

- **shape**: the 3.3B flow-matching DiT with DINOv2-L conditioning and the
  shape VAE -- 7.4 GB in fp16. A job with views (front / left / back / right)
  swaps in Hunyuan3D-2mv instead: the 2.0 flux-style DiT conditioned on up to
  four DINOv2-giant views with a per-view embedding, 4.9 GB. Only one of the
  two shape models is held at a time.
- **paint**: a 2.5D multiview UNet on Stable Diffusion 2.1 that draws albedo
  and metallic-roughness for six to nine fixed views of the mesh, conditioned
  on DINOv2-giant features of the photo, then Real-ESRGAN x4 on each view

Both stay in system memory between jobs and only the one in use sits on the
card: `place` moves the other off first. That is the same thing Tencent's
`--low_vram_mode` does, without reloading from disk.

The paint stage is `textureGenPipeline.Hunyuan3DPaintPipeline.__call__`
step for step -- view selection, normal and position renders, multiview
diffusion, upscale, back-projection, inpainting -- with three substitutions:
its OBJ round trip through Blender is `glb.write_glb`, Real-ESRGAN is loaded
by spandrel instead of basicsr, and the metallic-roughness map is read as the
glTF layout it is drawn in (roughness G, metallic B). The upstream
`get_texture_mr` reads R as metallic, which on its own training data is the
always-white channel.
"""

from __future__ import annotations

import gc
import os
import random
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import trimesh
from PIL import Image

from . import vendor
from .glb import TexturedMesh

#: The candidate cameras `Hunyuan3DPaintConfig` sets up: six axis views, then
#: a ring above and a ring below. The first six are always taken.
_AXIS = [(0, 0, 1.0), (0, 90, 0.1), (0, 180, 0.5), (0, 270, 0.1), (90, 0, 0.05), (-90, 180, 0.05)]


def candidate_views() -> tuple[list[float], list[float], list[float]]:
    elevs = [e for e, _, _ in _AXIS]
    azims = [a for _, a, _ in _AXIS]
    weights = [w for _, _, w in _AXIS]
    for azim in range(0, 360, 30):
        for elev in (20, -20):
            elevs.append(elev)
            azims.append(azim)
            weights.append(0.01)
    return elevs, azims, weights


@dataclass
class Paths:
    shape_dir: Path  # hunyuan3d-dit-v2-1: config.yaml + model.fp16.ckpt
    paint_dir: Path  # hunyuan3d-paintpbr-v2-1: a diffusers folder
    dino_dir: Path  # facebook/dinov2-giant
    upscaler: Path  # RealESRGAN_x4plus.pth
    rembg_home: Path  # where rembg keeps its ONNX cut-out models
    rembg_model: str = "birefnet-general"
    mv_shape_dir: Path | None = None  # hunyuan3d-dit-v2-mv: config.yaml + model.fp16.safetensors


@dataclass
class ShapeParams:
    seed: int
    steps: int = 30
    guidance: float = 5.0
    octree: int = 256
    num_chunks: int = 200_000


@dataclass
class PaintParams:
    views: int = 6
    resolution: int = 512
    steps: int = 15
    guidance: float = 3.0
    texture_size: int = 2048
    upscale: bool = True
    project_face: bool = False


Hook = Callable[[str, str, str | None], None]
"""(event, key, detail): "start"/"finish"/"describe" for a timeline step."""


class Engine:
    def __init__(self, paths: Paths, device: str = "cuda") -> None:
        self.paths = paths
        self.device = device
        self.shape: Any = None
        self.shape_kind: str | None = None  # "single" | "mv"
        self.paint: Any = None
        self.dino: Any = None
        self.upscaler: Any = None
        self._on_card: str | None = None

    # --- loading -------------------------------------------------------------

    @property
    def shape_loaded(self) -> bool:
        return self.shape is not None

    @property
    def paint_loaded(self) -> bool:
        return self.paint is not None

    def load_shape(self, kind: str = "single") -> None:
        if self.shape is not None and self.shape_kind == kind:
            return
        vendor.install()
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

        if self.shape is not None:
            # 7.4 + 4.9 GB is more system memory than either is worth keeping
            if self._on_card == "shape":
                self._on_card = None
            self.shape = None
            self.shape_kind = None
            gc.collect()
            torch.cuda.empty_cache()
        if kind == "mv":
            self.shape = _load_mv(Hunyuan3DDiTFlowMatchingPipeline, self.paths.mv_shape_dir)
        else:
            folder = self.paths.shape_dir
            self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_single_file(
                str(folder / "model.fp16.ckpt"),
                str(folder / "config.yaml"),
                device="cpu",
                dtype=torch.float16,
            )
        self.shape_kind = kind

    def load_paint(self) -> None:
        if self.paint is not None:
            return
        vendor.install()
        from diffusers import DiffusionPipeline, UniPCMultistepScheduler
        from hunyuanpaintpbr.unet.modules import Dino_v2

        custom = Path(vendor.install()) / "hy3dpaint" / "hunyuanpaintpbr"
        pipeline = DiffusionPipeline.from_pretrained(
            str(self.paths.paint_dir),
            custom_pipeline=str(custom),
            torch_dtype=torch.float16,
            # Local code only: the pipeline is the vendored checkout's, the
            # UNet's is the weight folder's, and the arm runs with the hub
            # offline. Newer diffusers asks for this either way.
            trust_remote_code=True,
        )
        pipeline.scheduler = UniPCMultistepScheduler.from_config(
            pipeline.scheduler.config, timestep_spacing="trailing"
        )
        pipeline.set_progress_bar_config(disable=True)
        pipeline.eval()
        pipeline.view_size = 512
        # Twelve views decoded at once is a few GB of activations at the peak
        # of the job; one at a time costs nothing measurable.
        pipeline.vae.enable_slicing()
        self.paint = pipeline
        self.dino = Dino_v2(str(self.paths.dino_dir)).to(torch.float16).eval()

        import spandrel

        self.upscaler = spandrel.ModelLoader().load_from_file(str(self.paths.upscaler)).eval().half()

    def place(self, stage: str) -> None:
        """Put `stage`'s models on the card and everything else in system memory."""
        if self._on_card == stage:
            return
        if stage == "shape":
            self._paint_to("cpu")
            gc.collect()
            torch.cuda.empty_cache()
            self.shape.to(self.device, torch.float16)
        else:
            if self.shape is not None:
                self.shape.to("cpu", torch.float16)
            gc.collect()
            torch.cuda.empty_cache()
            self._paint_to(self.device)
        self._on_card = stage

    def _paint_to(self, device: str) -> None:
        if self.paint is None:
            return
        self.paint.to(device)
        # DINOv2-giant is 2.3 GB and runs once per job, before the UNet: it
        # stays in system memory and visits the card for that one call.
        self.upscaler.to(device)

    # --- background ------------------------------------------------------------

    def cut_out(self, image: Image.Image) -> Image.Image:
        """The object on transparency, as the shape model's preprocessor wants it.

        A session per cut-out rather than one kept warm: onnxruntime's CUDA
        arena keeps what BiRefNet used (a few GB) until the session is gone,
        and on a 16 GB card that is exactly what the shape decode then spills
        into shared memory for. Opening one costs a couple of seconds.
        """
        import os

        os.environ.setdefault("U2NET_HOME", str(self.paths.rembg_home))
        from rembg import new_session, remove

        session = new_session(self.paths.rembg_model)
        try:
            return remove(image.convert("RGB"), session=session).convert("RGBA")
        finally:
            del session
            gc.collect()

    # --- shape -----------------------------------------------------------------

    def make_shape(
        self,
        image: Image.Image | dict[str, Image.Image],
        params: ShapeParams,
        on_step: Callable[[int, int], None],
    ) -> trimesh.Trimesh:
        """One image for the 2.1 model, or {view: image} (front/left/back/right) for 2mv."""
        self.load_shape("mv" if isinstance(image, dict) else "single")
        self.place("shape")
        generator = torch.Generator(device=self.device).manual_seed(params.seed)

        def callback(step: int, _t: Any, _outputs: Any) -> None:
            on_step(step + 1, params.steps)

        meshes = self.shape(
            image=image,
            num_inference_steps=params.steps,
            guidance_scale=params.guidance,
            generator=generator,
            octree_resolution=params.octree,
            num_chunks=params.num_chunks,
            output_type="trimesh",
            enable_pbar=False,
            callback=callback,
            callback_steps=1,
        )
        mesh = meshes[0] if isinstance(meshes, list) else meshes
        if mesh is None:
            raise RuntimeError("the shape model returned no surface -- the cut-out may be empty")
        return mesh

    # --- paint -----------------------------------------------------------------

    def paint_mesh(
        self,
        mesh: trimesh.Trimesh,
        reference: Image.Image,
        params: PaintParams,
        seed: int,
        hook: Hook,
        on_step: Callable[[int, int], None],
        face: Image.Image | None = None,
    ) -> TexturedMesh:
        vendor.install()
        from DifferentiableRenderer.MeshRender import MeshRender
        from utils.pipeline_utils import ViewProcessor

        self.place("paint")

        # Baked at twice the delivered size and halved, as upstream does with
        # 4096 -> 2048: the back-projection is point sampled, and the halving
        # is the antialiasing.
        bake_size = min(params.texture_size * 2, 4096)
        render_size = 2048
        config = _PaintConfig(params, bake_size, render_size)
        render = MeshRender(
            default_resolution=render_size, texture_size=bake_size, bake_mode="back_sample", raster_mode="cr"
        )
        views = ViewProcessor(config, render)

        hook("start", "unwrap", f"{len(mesh.faces):,} faces")
        # with the face projected, the head gets several times its share of the texture
        head = None
        if params.project_face:
            alpha = np.asarray(reference.convert("RGBA").getchannel("A")) > 128
            head = _neck_fraction(alpha) + 0.03
        mesh = uv_wrap(mesh, head)
        vtx_pos = np.asarray(mesh.vertices, dtype=np.float32)
        pos_idx = np.asarray(mesh.faces, dtype=np.int32)
        vtx_uv = np.asarray(mesh.visual.uv, dtype=np.float32)
        render.set_mesh(vtx_pos, pos_idx, vtx_uv=vtx_uv, uv_idx=pos_idx.copy())
        hook("finish", "unwrap", f"{len(vtx_pos):,} verts / {len(pos_idx):,} faces")

        hook("start", "views", None)
        elevs, azims, weights = views.bake_view_selection(
            config.candidate_camera_elevs,
            config.candidate_camera_azims,
            config.candidate_view_weights,
            params.views,
        )
        normal_maps = views.render_normal_multiview(elevs, azims, use_abs_coor=True)
        position_maps = views.render_position_multiview(elevs, azims)
        hook("finish", "views", f"{len(elevs)} views")

        style = reference.resize((512, 512))
        if style.mode == "RGBA":
            white = Image.new("RGB", style.size, (255, 255, 255))
            white.paste(style, mask=style.getchannel("A"))
            style = white
        style = style.convert("RGB")

        hook("start", "diffuse", f"{len(elevs)} views × albedo + MR at {params.resolution}px")
        multiview = self._multiview(style, normal_maps + position_maps, params, seed, on_step)
        hook("finish", "diffuse", None)

        albedo = multiview["albedo"]
        mr = multiview["mr"]
        if params.upscale:
            hook("start", "upscale", f"{len(albedo) * 2} views")
            albedo = [self._upscale(image) for image in albedo]
            mr = [self._upscale(image) for image in mr]
            hook("finish", "upscale", None)
        albedo = [image.resize((render_size, render_size)) for image in albedo]
        mr = [image.resize((render_size, render_size)) for image in mr]

        hook("start", "bake", f"{bake_size}px")
        texture, mask = views.bake_from_multiview(albedo, elevs, azims, weights)
        texture_mr, mask_mr = views.bake_from_multiview(mr, elevs, azims, weights)
        hook("finish", "bake", f"coverage {float(mask.float().mean()):.0%}")

        if params.project_face:
            hook("start", "face", "front view onto the head")
            texture, mask, note = self._project_face(render, reference, texture, mask, render_size, face)
            hook("finish", "face", note)

        # Down to the delivered size first, then inpainted: upstream inpaints
        # at bake size and halves afterwards, which is the same picture for
        # four times the work in OpenCV's single-threaded Navier-Stokes.
        hook("start", "inpaint", f"{params.texture_size}px")
        texture, mask = _downsample(texture, mask, params.texture_size)
        texture_mr, mask_mr = _downsample(texture_mr, mask_mr, params.texture_size)
        color = views.texture_inpaint(texture, mask).cpu().numpy()
        mr = views.texture_inpaint(texture_mr, mask_mr).cpu().numpy()
        hook("finish", "inpaint", None)

        out_pos, out_idx, out_uv, _ = render.get_mesh(normalize=False)
        color = _to_uint8(color, params.texture_size)
        mr_map = _to_uint8(mr, params.texture_size)

        normals = trimesh.Trimesh(out_pos, out_idx, process=False).vertex_normals
        torch.cuda.empty_cache()
        return TexturedMesh(
            positions=out_pos,
            normals=np.asarray(normals, dtype=np.float32),
            uvs=out_uv,
            faces=out_idx.astype(np.uint32),
            base_color=color,
            roughness=mr_map[..., 1],
            metallic=mr_map[..., 2],
        )

    def _multiview(
        self,
        style: Image.Image,
        conditions: list[Image.Image],
        params: PaintParams,
        seed: int,
        on_step: Callable[[int, int], None],
    ) -> dict[str, list[Image.Image]]:
        """`multiviewDiffusionNet.forward_one`, with the seed and step count the job's."""
        random.seed(seed)
        np.random.seed(seed % 2**32)
        torch.manual_seed(seed)

        size = params.resolution
        style = style.resize((size, size))
        conditions = [image.resize((size, size)) for image in conditions]
        for index, image in enumerate(conditions):
            if image.mode == "L":
                conditions[index] = image.point(lambda x: 255 if x > 1 else 0, mode="1")

        count = len(conditions) // 2
        kwargs: dict[str, Any] = {
            "generator": torch.Generator(device=self.device).manual_seed(seed),
            "width": size,
            "height": size,
            "num_in_batch": count,
            "images_normal": [conditions[:count]],
            "images_position": [conditions[count:]],
        }
        if getattr(self.paint.unet, "use_dino", False):
            self.dino.to(self.device)
            try:
                kwargs["dino_hidden_states"] = self.dino(style)
            finally:
                self.dino.to("cpu")
        # What the renders left in torch's cache -- the UV rasterization at
        # bake size is several GB -- goes back before the UNet's peak.
        gc.collect()
        torch.cuda.empty_cache()

        def callback(_pipe: Any, step: int, _t: Any, tensors: dict[str, Any]) -> dict[str, Any]:
            on_step(step + 1, params.steps)
            return tensors

        images = self.paint(
            [style],
            num_inference_steps=params.steps,
            prompt="high quality",
            sync_condition=None,
            guidance_scale=params.guidance,
            callback_on_step_end=callback,
            **kwargs,
        ).images
        return {"albedo": images[:count], "mr": images[count:]}

    @torch.no_grad()
    def _project_face(
        self,
        render: Any,
        reference: Image.Image,
        texture: torch.Tensor,
        mask: torch.Tensor,
        size: int,
        face: Image.Image | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, str]:
        """Paint the head from the front reference itself, not from the multiview diffusion.

        The paint views frame the whole body, so a face is some fifty pixels in them and bakes as
        blotches and seams. The mesh was shaped from this very image, so its front silhouette lines
        up with the subject's: scale the cut-out to the mesh's front render (height, centre, top),
        upscale the head x4 and project it from the front camera. It replaces the diffusion texture
        only on the top of the body where the surface faces the camera, feathered so there is no seam.
        """
        # where the mesh is in the front view, in the orientation the paint views use
        normal = render.render_normal(0, 0, resolution=size, bg_color=[-1, -1, -1], return_type="np")
        solid = np.asarray(normal)[..., :3].sum(-1) > 0.02
        rows, cols = np.nonzero(solid)
        if rows.size == 0:
            return texture, mask, "skipped: empty front render"
        m_top, m_bottom = int(rows.min()), int(rows.max())
        m_mid = (cols.min() + cols.max()) / 2

        cut = reference.convert("RGBA")
        alpha = np.asarray(cut.getchannel("A")) > 128
        r_rows, r_cols = np.nonzero(alpha)
        if r_rows.size == 0:
            return texture, mask, "skipped: empty cut-out"
        r_top, r_bottom = int(r_rows.min()), int(r_rows.max())
        r_mid = (r_cols.min() + r_cols.max()) / 2
        scale = (m_bottom - m_top + 1) / (r_bottom - r_top + 1)

        # the head band of the reference (down to the neck: a realistic head is the top eighth, a chibi
        # head nearly half), upscaled, placed where the mesh's head is
        neck = _neck_fraction(alpha)
        head_h = int((r_bottom - r_top + 1) * (neck + 0.06))
        x0 = max(0, int(r_mid - head_h))
        x1 = min(cut.width, int(r_mid + head_h))
        crop = cut.crop((x0, r_top, x1, r_top + head_h))
        rgb = Image.new("RGB", crop.size, (255, 255, 255))
        rgb.paste(crop, mask=crop.getchannel("A"))
        if self.upscaler is not None:
            rgb = self._upscale(rgb)
        detail = "front view"
        if face is not None:
            rgb, detail = _merge_face(rgb, crop, face)
        # MeshRender.set_mesh turns (x, y, z) into (-x, z, -y): height is -z there, y is depth
        height = -render.vtx_pos[:, 2]
        y_min, y_max = float(height.min()), float(height.max())
        span = y_max - y_min

        # At full-body framing the head is a few hundred pixels of the view, however sharp the image:
        # zoom the (orthographic) front camera onto the head -- move the mesh so the head is at the
        # origin and narrow the view -- project, then put both back. The zoomed view is the full one
        # scaled by z about the head centre's pixel, which is read off the two silhouettes.
        head_lo = y_max - (neck + 0.06) * span
        original = render.vtx_pos
        top_part = original[-original[:, 2] > head_lo]
        shift = torch.zeros_like(original[0])
        shift[0] = (top_part[:, 0].min() + top_part[:, 0].max()) / 2
        shift[2] = -(head_lo + y_max) / 2
        s0 = render.ortho_scale
        s1 = min(s0, (y_max - head_lo) * 1.3)
        z = s0 / s1
        texels = getattr(render, "tex_position", None)
        try:
            render.vtx_pos = original - shift
            # the back_sample bake projects precomputed texel positions, not the vertices: move those too
            if texels is not None:
                render.tex_position = torch.cat((texels[:, :3] - shift, texels[:, 3:]), dim=1)
            render.set_orth_scale(s1)
            zoom = render.render_normal(0, 0, resolution=size, bg_color=[-1, -1, -1], return_type="np")
            z_solid = np.asarray(zoom)[..., :3].sum(-1) > 0.02
            z_rows = np.nonzero(z_solid.any(1))[0]
            if z_rows.size == 0:
                return texture, mask, "skipped: empty zoomed render"
            c_y = m_top - (z_rows.min() - size / 2) / z
            # x: the silhouette's middle on a row through the head, in both views
            row = m_top + int(0.5 * (y_max - head_lo) / span * (m_bottom - m_top))
            f_cols = np.nonzero(solid[row])[0]
            z_cols = np.nonzero(z_solid[int(np.clip(size / 2 + (row - c_y) * z, 0, size - 1))])[0]
            if f_cols.size == 0 or z_cols.size == 0:
                return texture, mask, "skipped: no head row in the renders"
            c_x = (f_cols.min() + f_cols.max()) / 2 - ((z_cols.min() + z_cols.max()) / 2 - size / 2) / z
            w = max(1, round(crop.width * scale * z))
            h = max(1, round(crop.height * scale * z))
            left = size / 2 + (m_mid - (r_mid - x0) * scale - c_x) * z
            top = size / 2 + (m_top - c_y) * z
            # refine on the silhouettes themselves: the cut-out's alpha against the mesh's zoomed render
            # (hair pins sticking out pull a bounding-box estimate off by tens of pixels)
            left, top, w, h, fit = _register(crop.getchannel("A"), z_solid, left, top, w, h)
            placed = Image.new("RGB", (size, size), (255, 255, 255))
            placed.paste(rgb.resize((w, h), Image.Resampling.LANCZOS), (round(left), round(top)))
            image = torch.tensor(np.asarray(placed) / 255.0).float()
            projected, cos_map, _ = render.back_project(image, 0, 0)
        finally:
            render.vtx_pos = original
            if texels is not None:
                render.tex_position = texels
            render.set_orth_scale(s0)

        # head texels facing the camera: height from the UV position map, feathered
        pos = render.uv_feature_map(render.vtx_pos)
        y = -pos[..., 2:3]
        band = torch.clamp((y - (y_max - neck * span)) / (0.03 * span), 0, 1)
        facing = torch.clamp((cos_map - 0.45) / 0.3, 0, 1)
        weight = band * facing
        debug = os.environ.get("HY3D_FACE_DEBUG")
        if debug:
            out = Path(debug)
            out.mkdir(parents=True, exist_ok=True)

            def dump(name: str, t: torch.Tensor) -> None:
                pixels = (t.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
                Image.fromarray(pixels.squeeze(-1) if pixels.shape[-1] == 1 else pixels).save(out / name)

            placed.save(out / "placed.png")
            Image.fromarray((z_solid * 255).astype(np.uint8)).save(out / "zoom-mask.png")
            for name, t in (("weight", weight), ("band", band), ("facing", facing)):
                dump(f"{name}.png", t)
            dump("projected.png", projected[..., :3])
        if weight.shape[:2] != texture.shape[:2]:
            return texture, mask, f"skipped: texture {tuple(texture.shape[:2])} vs {tuple(weight.shape[:2])}"
        blended = texture * (1 - weight) + projected[..., :3] * weight
        mask = mask | (weight > 0.01).reshape(mask.shape)
        share = float((weight > 0.5).float().mean())
        return (
            blended,
            mask,
            f"{share:.1%} of the texture from the {detail}"
            f" (head = top {neck:.0%}, zoom x{z:.1f}, fit {fit:.2f})",
        )

    @torch.no_grad()
    def _upscale(self, image: Image.Image) -> Image.Image:
        pixels = torch.from_numpy(np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0)
        batch = pixels.permute(2, 0, 1).unsqueeze(0).to(self.device, torch.float16)
        out = self.upscaler(batch).clamp(0, 1)
        array = (out[0].permute(1, 2, 0).float().cpu().numpy() * 255.0).round().astype(np.uint8)
        return Image.fromarray(array)


def _load_mv(pipeline_class: Any, folder: Path | None) -> Any:
    """Hunyuan3D-2mv through the 2.1 code, which still carries every 2.0 class it names.

    Its config was written for the 2.0 package (`hy3dgen.shapegen.*`); the same
    classes live under `hy3dshape.*` in the 2.1 checkout, so the targets are
    renamed into a copy next to the weights. The safetensors file, not the
    pickle, is what is loaded.
    """
    if folder is None or not (folder / "model.fp16.safetensors").is_file():
        raise RuntimeError(f"Hunyuan3D-2mv weights are not at {folder} -- see README.md")
    config = folder / "config.hy3dshape.yaml"
    text = (folder / "config.yaml").read_text(encoding="utf8").replace("hy3dgen.shapegen.", "hy3dshape.")
    if not config.is_file() or config.read_text(encoding="utf8") != text:
        config.write_text(text, encoding="utf8")
    return pipeline_class.from_single_file(
        str(folder / "model.fp16.ckpt"), str(config), device="cpu", dtype=torch.float16, use_safetensors=True
    )


def uv_wrap(mesh: trimesh.Trimesh, head: float | None = None, boost: float = 2.5) -> trimesh.Trimesh:
    """xatlas, as `utils.uvwrap_utils.mesh_uv_wrap` -- optionally with more texture for the head.

    xatlas sizes every chart by its 3D area, so a head that is a few percent of the surface gets a
    few percent of the map: a face some fifty texels across, blurred whatever is projected onto
    it. With `head` (the top fraction of the height that is head), the head's faces are split off
    and scaled up by `boost` in the copy that is parametrised -- only the UV layout changes -- so
    they get about boost^2 times their share.
    """
    import xatlas

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    params = vertices
    if head is not None:
        y = vertices[:, 1]
        cut = y.max() - head * (y.max() - y.min())
        is_head = vertices[faces].mean(1)[:, 1] > cut
        if is_head.any() and not is_head.all():
            # head faces get their own copies of the vertices they share with the body
            shared = np.intersect1d(np.unique(faces[is_head]), np.unique(faces[~is_head]))
            remap = np.arange(len(vertices))
            remap[shared] = len(vertices) + np.arange(len(shared))
            vertices = np.concatenate([vertices, vertices[shared]])
            faces = faces.copy()
            faces[is_head] = remap[faces[is_head]]
            params = vertices.copy()
            ids = np.unique(faces[is_head])
            centre = params[ids].mean(0)
            params[ids] = centre + (params[ids] - centre) * boost
    vmapping, indices, uvs = xatlas.parametrize(params, faces)
    out = trimesh.Trimesh(vertices[vmapping], indices, process=False)
    out.visual = trimesh.visual.TextureVisuals(uv=uvs)
    return out


def _register(
    alpha: Image.Image, target: np.ndarray, left: float, top: float, w: int, h: int
) -> tuple[float, float, int, int, float]:
    """Best placement of a cut-out's alpha over a silhouette, near an initial guess.

    Searched at a quarter of the resolution: scale within +-10% and shift within a fifth of the
    cut-out's size, scored by intersection over union. Returns (left, top, w, h, iou).
    """
    import cv2

    k = 0.25
    tgt = cv2.resize(target.astype(np.uint8), None, fx=k, fy=k, interpolation=cv2.INTER_AREA).astype(bool)
    best = (left, top, w, h, -1.0)
    for s in np.linspace(0.9, 1.1, 9):
        sw, sh = max(1, int(w * s * k)), max(1, int(h * s * k))
        a = np.asarray(alpha.resize((sw, sh), Image.Resampling.BILINEAR)) > 128
        cx0 = (left + w / 2) * k - sw / 2
        cy0 = (top + h / 2) * k - sh / 2
        reach = int(max(sw, sh) * 0.2)
        for dy in range(-reach, reach + 1, 2):
            for dx in range(-reach, reach + 1, 2):
                x, y = int(cx0 + dx), int(cy0 + dy)
                x0, y0 = max(x, 0), max(y, 0)
                x1, y1 = min(x + sw, tgt.shape[1]), min(y + sh, tgt.shape[0])
                if x1 <= x0 or y1 <= y0:
                    continue
                win = tgt[y0:y1, x0:x1]
                part = a[y0 - y : y1 - y, x0 - x : x1 - x]
                # the target also has the shoulders below the crop: compare inside the crop only
                iou = (win & part).sum() / max(1, (win | part).sum())
                if iou > best[4]:
                    best = (x / k, y / k, int(sw / k), int(sh / k), float(iou))
    return best


def _neck_fraction(alpha: np.ndarray) -> float:
    """Height of the head as a fraction of the subject: the narrowest silhouette row 12-60% down.

    Above 12% are buns, horns and hair ornaments, narrower than any neck; below the neck the
    shoulders (and in an A-pose the arms) only get wider.
    """
    rows = np.nonzero(alpha.any(1))[0]
    if rows.size == 0:
        return 0.16
    top, height = int(rows.min()), int(rows.max() - rows.min() + 1)
    best, best_w = 0.16, None
    for f in np.arange(0.12, 0.60, 0.01):
        xs = np.nonzero(alpha[top + int(f * height)])[0]
        if xs.size == 0:
            continue
        w = int(xs.max() - xs.min() + 1)
        if best_w is None or w < best_w:
            best, best_w = float(f), w
    return best


def _merge_face(head: Image.Image, crop: Image.Image, face: Image.Image) -> tuple[Image.Image, str]:
    """Put a high-resolution close-up of the face into the (upscaled) head crop of the front view.

    The close-up is a separate image of the same head, so it is located by matching the low-res
    head crop inside it at several scales (normalised cross-correlation on greyscale). Only the
    middle of the head is replaced, feathered: the outline (hair, ears) stays the front view's,
    which is what the mesh was shaped from.
    """
    import cv2

    flat = Image.new("RGB", crop.size, (255, 255, 255))
    flat.paste(crop, mask=crop.getchannel("A"))
    small = np.asarray(flat.convert("L"), dtype=np.float32)
    big = np.asarray(face.convert("RGB").convert("L"), dtype=np.float32)
    best = (-1.0, 0, 0, 1.0)
    for t in np.geomspace(0.5, 8.0, 40):
        w, h = int(crop.width * t), int(crop.height * t)
        if w < 32 or h < 32 or w > big.shape[1] or h > big.shape[0]:
            continue
        template = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
        result = cv2.matchTemplate(big, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, (ox, oy) = cv2.minMaxLoc(result)
        if score > best[0]:
            best = (float(score), ox, oy, float(t))
    score, ox, oy, t = best
    if score < 0.45:
        return head, f"front view (face close-up not matched: {score:.2f})"
    region = face.convert("RGB").crop((ox, oy, ox + int(crop.width * t), oy + int(crop.height * t)))
    region = region.resize(head.size, Image.Resampling.LANCZOS)
    # feathered ellipse over the face only (the crop runs from the top of the hair to the neck, the face
    # is its lower middle): hair, ornaments and outline stay the front view's, inside a softened alpha
    from PIL import ImageDraw, ImageFilter

    ellipse = Image.new("L", head.size, 0)
    draw = ImageDraw.Draw(ellipse)
    w, h = head.size
    draw.ellipse((w * 0.3, h * 0.3, w * 0.7, h * 0.98), fill=255)
    ellipse = ellipse.filter(ImageFilter.GaussianBlur(min(w, h) * 0.05))
    inside = crop.getchannel("A").resize(head.size).filter(ImageFilter.GaussianBlur(4))
    blend = Image.fromarray(
        (np.asarray(ellipse, dtype=np.float32) * np.asarray(inside) / 255).astype(np.uint8)
    )
    out = head.copy()
    out.paste(region, mask=blend)
    return out, f"face close-up (match {score:.2f}, x{t:.1f})"


class _PaintConfig:
    """The attributes `ViewProcessor` reads off `Hunyuan3DPaintConfig`."""

    def __init__(self, params: PaintParams, bake_size: int, render_size: int) -> None:
        self.device = "cuda"
        self.render_size = render_size
        self.texture_size = bake_size
        self.max_selected_view_num = params.views
        self.resolution = params.resolution
        self.bake_exp = 4
        self.merge_method = "fast"
        self.candidate_camera_elevs, self.candidate_camera_azims, self.candidate_view_weights = (
            candidate_views()
        )


def _downsample(texture: torch.Tensor, mask: torch.Tensor, size: int) -> tuple[torch.Tensor, np.ndarray]:
    """A baked map and its coverage at `size`, averaging only the texels that were baked."""
    from torch.nn import functional

    weight = mask.float().reshape(1, 1, *mask.shape[:2])
    if texture.shape[0] != size:
        colour = texture.permute(2, 0, 1).unsqueeze(0)
        summed = functional.adaptive_avg_pool2d(colour * weight, size)
        weight = functional.adaptive_avg_pool2d(weight, size)
        texture = (summed / weight.clamp(min=1e-6))[0].permute(1, 2, 0)
    covered = (weight[0, 0] > 0.5).cpu().numpy()
    return texture.contiguous(), (covered * 255).astype(np.uint8)


def _to_uint8(texture: np.ndarray, size: int) -> np.ndarray:
    pixels = (np.clip(texture[..., :3], 0.0, 1.0) * 255.0).round().astype(np.uint8)
    if pixels.shape[0] != size:
        pixels = np.asarray(Image.fromarray(pixels).resize((size, size), Image.Resampling.LANCZOS))
    return pixels


def simplify(mesh: trimesh.Trimesh, faces: int) -> trimesh.Trimesh:
    """Floaters and degenerate faces out, then quadric decimation to `faces`.

    The official app's order. Upstream's paint stage then decimates again to
    40K on its own; here the job's figure is the only one.
    """
    vendor.install()
    from hy3dshape.postprocessors import DegenerateFaceRemover, FaceReducer, FloaterRemover

    mesh = FloaterRemover()(mesh)
    mesh = DegenerateFaceRemover()(mesh)
    if len(mesh.faces) > faces:
        mesh = FaceReducer()(mesh, max_facenum=faces)
    return mesh

"""Hunyuan3D 2.1, shape and paint, held in this process.

Two models that never run at once and do not fit on a 16 GB card together:

- **shape**: the 3.3B flow-matching DiT with DINOv2-L conditioning and the
  shape VAE -- 7.4 GB in fp16
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


Hook = Callable[[str, str, str | None], None]
"""(event, key, detail): "start"/"finish"/"describe" for a timeline step."""


class Engine:
    def __init__(self, paths: Paths, device: str = "cuda") -> None:
        self.paths = paths
        self.device = device
        self.shape: Any = None
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

    def load_shape(self) -> None:
        if self.shape is not None:
            return
        vendor.install()
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

        folder = self.paths.shape_dir
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_single_file(
            str(folder / "model.fp16.ckpt"),
            str(folder / "config.yaml"),
            device="cpu",
            dtype=torch.float16,
        )

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
        self, image: Image.Image, params: ShapeParams, on_step: Callable[[int, int], None]
    ) -> trimesh.Trimesh:
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
    ) -> TexturedMesh:
        vendor.install()
        from DifferentiableRenderer.MeshRender import MeshRender
        from utils.pipeline_utils import ViewProcessor
        from utils.uvwrap_utils import mesh_uv_wrap

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
        mesh = mesh_uv_wrap(mesh)
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
    def _upscale(self, image: Image.Image) -> Image.Image:
        pixels = torch.from_numpy(np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0)
        batch = pixels.permute(2, 0, 1).unsqueeze(0).to(self.device, torch.float16)
        out = self.upscaler(batch).clamp(0, 1)
        array = (out[0].permute(1, 2, 0).float().cpu().numpy() * 255.0).round().astype(np.uint8)
        return Image.fromarray(array)


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

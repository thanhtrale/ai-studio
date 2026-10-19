"""Pixal3D, loaded once and kept: one photo in, a textured GLB out.

The pipeline is Tencent ARC's own (vendor/Pixal3D). It runs in its low-VRAM
mode -- every flow model waits in system RAM and is moved to the card for its
stage only -- because the standard mode holds all of them at once (~18 GB),
more than a 16 GB card.
"""

from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

VENDOR = Path(__file__).resolve().parents[2] / "vendor" / "Pixal3D"

#: glTF's +Y up, +Z toward the viewer. Pixal3D exports facing -Z (its own
#: rotation turns Z-up into Y-up but leaves the subject facing away), so the
#: photographed front is turned 180 degrees about Y on top of it.
TO_GLTF = np.array(
    [
        [1, 0, 0, 0],
        [0, 0, -1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 1],
    ],
    dtype=np.float64,
)


@dataclass
class Paths:
    model_dir: Path
    hf_home: Path
    torch_home: Path
    rembg_home: Path
    rembg_model: str = "birefnet-general"


@dataclass
class Params:
    seed: int
    resolution: int = 1024
    ss_steps: int = 12
    shape_steps: int = 12
    tex_steps: int = 12
    ss_guidance: float = 7.5
    shape_guidance: float = 7.5
    target_faces: int = 150_000
    texture_size: int = 4096
    fov: float = -1.0


class Engine:
    def __init__(self, paths: Paths) -> None:
        self.paths = paths
        os.environ["HF_HOME"] = str(paths.hf_home)
        os.environ["TORCH_HOME"] = str(paths.torch_home)
        os.environ.setdefault("ATTN_BACKEND", "sdpa")
        if str(VENDOR) not in sys.path:
            sys.path.insert(0, str(VENDOR))
        self.pipeline = None
        self._rembg = None

    @property
    def loaded(self) -> bool:
        return self.pipeline is not None

    def load(self) -> None:
        # inference.py chdirs nothing, but the flex_gemm autotune cache lands next to it
        os.environ.setdefault(
            "FLEX_GEMM_AUTOTUNE_CACHE_PATH", str(self.paths.model_dir / "autotune_cache.json")
        )
        import pixal3d.pipelines.rembg as rembg

        class _NoRembg:
            """The pipeline's own cut-out is RMBG-2.0, a gated repo: this arm cuts out with rembg instead."""

            def __init__(self, **_: object) -> None:
                pass

            def to(self, *_: object) -> _NoRembg:
                return self

            def cpu(self) -> _NoRembg:
                return self

            def __call__(self, _: Image.Image) -> Image.Image:
                raise RuntimeError("the pipeline was handed an image without alpha")

        rembg.BiRefNet = _NoRembg
        import inference

        self._inference = inference
        self.pipeline = inference.init_pipeline(str(self.paths.model_dir), low_vram=True)

    def cutout(self, photo: Image.Image) -> Image.Image:
        """RGBA with the subject only; a photo that already has real alpha is kept as it is.

        "Real" means a visible share of the picture is transparent: Qwen-Image writes RGBA with alpha 248-255
        everywhere, which taken as a mask turned the white background into slabs around the subject.
        """
        if photo.mode == "RGBA" and (np.asarray(photo)[:, :, 3] < 128).mean() > 0.05:
            return photo
        os.environ["U2NET_HOME"] = str(self.paths.rembg_home)
        from rembg import new_session, remove

        if self._rembg is None:
            self._rembg = new_session(self.paths.rembg_model)
        return remove(photo.convert("RGB"), session=self._rembg)

    def camera(self, image_path: Path, fov: float) -> dict:
        import torch

        inf = self._inference
        if fov > 0:
            grid_point = torch.tensor([-1.0, 0.0, 0.0])
            distance = inf.distance_from_fov(fov, grid_point, torch.tensor([0, 511]), 1.0, 512)[
                "distance_from_x"
            ]
            return {"camera_angle_x": fov, "distance": distance, "mesh_scale": 1.0}
        moge = inf.load_moge_model(device="cuda")
        try:
            return inf.get_camera_params_wild_moge(str(image_path), moge, device="cuda")
        finally:
            moge.cpu()
            del moge
            torch.cuda.empty_cache()

    def generate(self, cut: Image.Image, scratch: Path, out: Path, p: Params, progress) -> dict:
        import o_voxel
        import torch

        pipe = self.pipeline
        with progress.step("prepare", "Crop and centre"):
            image = pipe.preprocess_image(cut)
            scratch.parent.mkdir(parents=True, exist_ok=True)
            image.save(scratch)
        with progress.step("camera", "Estimate camera", "MoGe-2" if p.fov <= 0 else f"fov {p.fov:.3f}"):
            cam = self.camera(scratch, p.fov)
        scratch.unlink(missing_ok=True)
        with progress.step(
            "sample", "Sample structure, shape and texture", f"{p.resolution} cascade · seed {p.seed}"
        ):
            torch.manual_seed(p.seed)
            meshes, (_, _, res) = pipe.run(
                image,
                camera_params=cam,
                seed=p.seed,
                sparse_structure_sampler_params={"steps": p.ss_steps, "guidance_strength": p.ss_guidance},
                shape_slat_sampler_params={"steps": p.shape_steps, "guidance_strength": p.shape_guidance},
                tex_slat_sampler_params={"steps": p.tex_steps},
                preprocess_image=False,
                return_latent=True,
                pipeline_type=f"{p.resolution}_cascade",
            )
        mesh = meshes[0]
        with progress.step(
            "export", "Remesh, bake and write GLB", f"≤{p.target_faces:,} faces · {p.texture_size}px"
        ):
            glb = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices,
                faces=mesh.faces,
                attr_volume=mesh.attrs,
                coords=mesh.coords,
                attr_layout=pipe.pbr_attr_layout,
                grid_size=res,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=p.target_faces,
                texture_size=p.texture_size,
                remesh=True,
                remesh_band=1,
                remesh_project=0,
            )
            glb.apply_transform(TO_GLTF)
            out.parent.mkdir(parents=True, exist_ok=True)
            glb.export(str(out), extension_webp=True)
            faces = len(glb.faces) if hasattr(glb, "faces") else None
            vertices = len(glb.vertices) if hasattr(glb, "vertices") else None
        del meshes, mesh
        torch.cuda.empty_cache()
        return {
            "faces": faces,
            "vertices": vertices,
            "cameraAngleX": round(float(cam["camera_angle_x"]), 4),
            "fovDegrees": round(math.degrees(float(cam["camera_angle_x"])), 1),
        }

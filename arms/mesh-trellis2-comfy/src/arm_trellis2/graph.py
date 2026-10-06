"""The TRELLIS.2 image-to-textured-mesh workflow, in ComfyUI's API format.

Translated from Comfy-Org's own template, `3d_pixal3d_trellis2_image_to_model`,
with its switch set to TRELLIS.2: the CFG intervals and rescales, the shift of
5 on the structure pass, the step counts and the bake chain are that
template's, because they are what reproduces Microsoft's default pipeline.

Four sampling passes on one transformer, which the stage nodes switch between:

    structure (16³ occupancy) → shape at 512 → shape upsampled to 1024/1536
                                                        ↓
                                     texture, conditioned on that shape

Then the mesh is made fit for a page: remeshed, decimated, UV-unwrapped, and
the texture voxels baked into base colour, metallic and roughness maps --
optionally with a normal map and ambient occlusion baked from the dense mesh
onto the light one, which is what keeps detail a decimation threw away.

Departures from the template:

* No preview, info or switch nodes -- they show things to a person at the
  canvas and do nothing to the result.
* The texture resolution and face count are the job's, not 4096 and 700K,
  which make a 50 MB file a browser will choke on.
* No orientation fix. `VaeDecodeShapeTrellis` already turns TRELLIS.2's Z-up
  frame into glTF's Y-up.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The template's, per pass.
DEFAULT_STRUCTURE_STEPS = 12
DEFAULT_SHAPE_STEPS = 20
DEFAULT_REFINE_STEPS = 12
DEFAULT_TEXTURE_STEPS = 12
DEFAULT_CFG = 7.5
#: The texture pass runs unguided in the template.
TEXTURE_CFG = 1.0
STRUCTURE_SHIFT = 5.0
#: Guidance only over the early part of each shape pass, then CFG 1: what the
#: template calls matching "the original default pipeline behaviour".
STRUCTURE_CFG_UNTIL = 0.667
STRUCTURE_RESCALE = 0.7
SHAPE_CFG_UNTIL = 0.769
SHAPE_RESCALE = 0.5
STRUCTURE_RESOLUTION = "32"
SHAPE_RESOLUTIONS = (1024, 1536)
DEFAULT_SHAPE_RESOLUTION = 1024
#: The dense remesh the bakes read detail from. The template's.
REMESH_RESOLUTION = 768
REMESH_SMOOTH_ITERS = 20
DEFAULT_TARGET_FACES = 100_000
DEFAULT_TEXTURE_SIZE = 2048
#: TRELLIS.2 is conditioned on the object filling the frame on black, which is
#: what the conditioning node's own tooltip asks for.
CONDITION_EDGE = 1024
CROP_PAD = 1.0
BACKGROUND = "#000000"
AO_SAMPLES = 64

#: Node ids, stable across jobs so ComfyUI's cache can reuse the loaders, the
#: cut-out and the image encode between seeds.
UNET = "unet"
CLIP_VISION = "clip_vision"
SHAPE_VAE = "shape_vae"
TEXTURE_VAE = "texture_vae"
REF = "ref"
BG_MODEL = "bg_model"
MASK = "mask"
CUTOUT = "cutout"
COND = "cond"
STRUCTURE_MODEL = "structure_model"
SHAPE_MODEL = "shape_model"
STRUCTURE_LATENT = "structure_latent"
STRUCTURE_SAMPLER = "structure_sampler"
STRUCTURE = "structure"
SHAPE_STAGE = "shape_stage"
SHAPE_SAMPLER = "shape_sampler"
UPSAMPLE = "upsample"
REFINE_SAMPLER = "refine_sampler"
SHAPE_DECODE = "shape_decode"
TEXTURE_STAGE = "texture_stage"
TEXTURE_SAMPLER = "texture_sampler"
TEXTURE_DECODE = "texture_decode"
REMESH = "remesh"
DECIMATE = "decimate"
SMOOTH = "smooth"
UNWRAP = "unwrap"
BAKE = "bake"
NORMALS = "normals"
OCCLUSION = "occlusion"
APPLY = "apply"
FINAL_SMOOTH = "final_smooth"
SAVE = "save"


#: What the timeline calls each node that does real work, in the order they
#: run. The loaders and the CFG patches are instant and left unnamed.
NODE_LABELS: dict[str, str] = {
    MASK: "Cut out the object",
    CUTOUT: "Crop to the object",
    COND: "Encode the image (DINOv3)",
    STRUCTURE_SAMPLER: "Sample structure",
    STRUCTURE: "Decode structure",
    SHAPE_SAMPLER: "Sample shape at 512",
    UPSAMPLE: "Upsample shape",
    REFINE_SAMPLER: "Refine shape",
    SHAPE_DECODE: "Decode shape",
    TEXTURE_SAMPLER: "Sample texture",
    TEXTURE_DECODE: "Decode texture",
    REMESH: "Remesh",
    DECIMATE: "Decimate",
    SMOOTH: "Smooth normals",
    UNWRAP: "Unwrap UVs",
    BAKE: "Bake colour, metal, roughness",
    NORMALS: "Bake normal map",
    OCCLUSION: "Bake ambient occlusion",
    APPLY: "Apply textures",
    SAVE: "Write GLB",
}


def labels_for(graph: dict[str, Any]) -> dict[str, str]:
    """The named nodes this particular graph contains -- optional bakes come and go."""
    return {node: label for node, label in NODE_LABELS.items() if node in graph}


@dataclass
class Models:
    """The weight files, as bare filenames ComfyUI's loaders resolve."""

    diffusion_model: str
    clip_vision: str
    shape_vae: str
    texture_vae: str
    bg_model: str
    weight_dtype: str = "default"


@dataclass
class Shape:
    """One textured mesh's worth of work. Everything here comes from the job."""

    reference: str
    seed: int
    structure_steps: int = DEFAULT_STRUCTURE_STEPS
    shape_steps: int = DEFAULT_SHAPE_STEPS
    refine_steps: int = DEFAULT_REFINE_STEPS
    texture_steps: int = DEFAULT_TEXTURE_STEPS
    cfg: float = DEFAULT_CFG
    shape_resolution: int = DEFAULT_SHAPE_RESOLUTION
    target_faces: int = DEFAULT_TARGET_FACES
    texture_size: int = DEFAULT_TEXTURE_SIZE
    bake_normals: bool = True
    bake_occlusion: bool = True
    remove_background: bool = True


def _sampler(
    model: str, stage: str, latent: list[Any], seed: int, steps: int, cfg: float, scheduler: str
) -> dict[str, Any]:
    return {
        "class_type": "KSampler",
        "inputs": {
            "model": [model, 0],
            "positive": [stage, 0],
            "negative": [stage, 1],
            "latent_image": latent,
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": "euler",
            "scheduler": scheduler,
            "denoise": 1.0,
        },
    }


def build(models: Models, shape: Shape, filename_prefix: str) -> dict[str, Any]:
    """The whole graph for one textured mesh, ready to POST to `/prompt`."""
    if shape.shape_resolution not in SHAPE_RESOLUTIONS:
        raise ValueError(f"shape resolution must be one of {SHAPE_RESOLUTIONS}")

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models.diffusion_model, "weight_dtype": models.weight_dtype},
        },
        CLIP_VISION: {"class_type": "CLIPVisionLoader", "inputs": {"clip_name": models.clip_vision}},
        SHAPE_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.shape_vae}},
        TEXTURE_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.texture_vae}},
        REF: {"class_type": "LoadImage", "inputs": {"image": shape.reference}},
    }

    # --- the photograph, cut out --------------------------------------------
    if shape.remove_background:
        graph[BG_MODEL] = {
            "class_type": "LoadBackgroundRemovalModel",
            "inputs": {"bg_removal_name": models.bg_model},
        }
        graph[MASK] = {
            "class_type": "RemoveBackground",
            "inputs": {"bg_removal_model": [BG_MODEL, 0], "image": [REF, 0]},
        }
        mask: list[Any] = [MASK, 0]
    else:
        # LoadImage's mask is the inverse of the alpha channel; the crop wants
        # the object as 1, so it is inverted back. A photo with no alpha comes
        # out as all object, which crops to the whole frame.
        graph[MASK] = {"class_type": "InvertMask", "inputs": {"mask": [REF, 1]}}
        mask = [MASK, 0]

    graph[CUTOUT] = {
        "class_type": "ImageCropToMask",
        "inputs": {
            "images": [REF, 0],
            "masks": mask,
            "width": CONDITION_EDGE,
            "height": CONDITION_EDGE,
            "pad_factor": CROP_PAD,
            "grow_mask": 0,
            "background": BACKGROUND,
        },
    }
    graph[COND] = {
        "class_type": "Trellis2Conditioning",
        "inputs": {"clip_vision_model": [CLIP_VISION, 0], "image": [CUTOUT, 0]},
    }

    # --- the two guided model variants --------------------------------------
    graph["structure_cfg"] = {
        "class_type": "CFGOverride",
        "inputs": {"model": [UNET, 0], "cfg": 1.0, "start_percent": STRUCTURE_CFG_UNTIL, "end_percent": 1.0},
    }
    graph["structure_rescale"] = {
        "class_type": "RescaleCFG",
        "inputs": {"model": ["structure_cfg", 0], "multiplier": STRUCTURE_RESCALE},
    }
    graph[STRUCTURE_MODEL] = {
        "class_type": "ModelSamplingSD3",
        "inputs": {"model": ["structure_rescale", 0], "shift": STRUCTURE_SHIFT},
    }
    graph["shape_cfg"] = {
        "class_type": "CFGOverride",
        "inputs": {"model": [UNET, 0], "cfg": 1.0, "start_percent": SHAPE_CFG_UNTIL, "end_percent": 1.0},
    }
    graph[SHAPE_MODEL] = {
        "class_type": "RescaleCFG",
        "inputs": {"model": ["shape_cfg", 0], "multiplier": SHAPE_RESCALE},
    }

    # --- structure → shape → refined shape → texture ------------------------
    graph[STRUCTURE_LATENT] = {"class_type": "EmptyTrellis2LatentStructure", "inputs": {"batch_size": 1}}
    graph[STRUCTURE_SAMPLER] = _sampler(
        STRUCTURE_MODEL,
        COND,
        [STRUCTURE_LATENT, 0],
        shape.seed + 14,
        shape.structure_steps,
        shape.cfg,
        "normal",
    )
    graph[STRUCTURE] = {
        "class_type": "VaeDecodeStructureTrellis2",
        "inputs": {
            "samples": [STRUCTURE_SAMPLER, 0],
            "vae": [SHAPE_VAE, 0],
            "resolution": STRUCTURE_RESOLUTION,
        },
    }
    graph[SHAPE_STAGE] = {
        "class_type": "Trellis2ShapeStage",
        "inputs": {"positive": [COND, 0], "negative": [COND, 1], "voxel": [STRUCTURE, 0]},
    }
    graph[SHAPE_SAMPLER] = _sampler(
        SHAPE_MODEL, SHAPE_STAGE, [SHAPE_STAGE, 2], shape.seed, shape.shape_steps, shape.cfg, "normal"
    )
    graph[UPSAMPLE] = {
        "class_type": "Trellis2UpsampleStage",
        "inputs": {
            "positive": [SHAPE_STAGE, 0],
            "negative": [SHAPE_STAGE, 1],
            "shape_latent": [SHAPE_SAMPLER, 0],
            "vae": [SHAPE_VAE, 0],
            "target_resolution": shape.shape_resolution,
        },
    }
    graph[REFINE_SAMPLER] = _sampler(
        SHAPE_MODEL, UPSAMPLE, [UPSAMPLE, 2], shape.seed, shape.refine_steps, shape.cfg, "simple"
    )
    graph[SHAPE_DECODE] = {
        "class_type": "VaeDecodeShapeTrellis",
        "inputs": {"samples": [REFINE_SAMPLER, 0], "vae": [SHAPE_VAE, 0]},
    }
    graph[TEXTURE_STAGE] = {
        "class_type": "Trellis2TextureStage",
        "inputs": {"positive": [UPSAMPLE, 0], "negative": [UPSAMPLE, 1], "shape_latent": [REFINE_SAMPLER, 0]},
    }
    graph[TEXTURE_SAMPLER] = _sampler(
        UNET, TEXTURE_STAGE, [TEXTURE_STAGE, 2], shape.seed + 1, shape.texture_steps, TEXTURE_CFG, "normal"
    )
    graph[TEXTURE_DECODE] = {
        "class_type": "VaeDecodeTextureTrellis",
        "inputs": {
            "samples": [TEXTURE_SAMPLER, 0],
            "vae": [TEXTURE_VAE, 0],
            "shape_subdivides": [SHAPE_DECODE, 1],
        },
    }

    # --- a mesh a page can carry --------------------------------------------
    graph[REMESH] = {
        "class_type": "RemeshMesh",
        "inputs": {
            "mesh": [SHAPE_DECODE, 0],
            "resolution": REMESH_RESOLUTION,
            # A dynamic combo: the option by name, its inputs as `<combo>.<input>`.
            "sign_mode": "udf",
            "sign_mode.qef": False,
            "sign_mode.drop_inverted_components": False,
            "sign_mode.drop_enclosed_components": False,
            "band": 1.0,
            "project_back": 0.0,
            "fix_poles": False,
            "smooth_iters": REMESH_SMOOTH_ITERS,
            "drop_small_components": 0.01,
            "precluster_max_verts": 20_000_000,
        },
    }
    graph[DECIMATE] = {
        "class_type": "DecimateMesh",
        "inputs": {
            "mesh": [REMESH, 0],
            "target_face_count": shape.target_faces,
            "placement_mode": "midpoint",
        },
    }
    graph[SMOOTH] = {
        "class_type": "MeshSmoothNormals",
        "inputs": {"mesh": [DECIMATE, 0], "crease_angle": 180.0},
    }
    graph[UNWRAP] = {
        "class_type": "UnwrapMesh",
        "inputs": {
            "mesh": [SMOOTH, 0],
            "segmenter": "pec",
            "resolution": shape.texture_size,
            "padding": 1,
            "weld_distance": 0.0002,
        },
    }
    graph[BAKE] = {
        "class_type": "BakeTextureFromVoxel",
        "inputs": {
            "mesh": [UNWRAP, 0],
            "voxel_colors": [TEXTURE_DECODE, 0],
            "texture_size": shape.texture_size,
            "reference_mesh": [SHAPE_DECODE, 0],
        },
    }

    apply_inputs: dict[str, Any] = {
        "mesh": [UNWRAP, 0],
        "base_color": [BAKE, 0],
        "metallic": [BAKE, 1],
        "roughness": [BAKE, 2],
    }
    if shape.bake_normals:
        graph[NORMALS] = {
            "class_type": "BakeNormalMapFromMesh",
            "inputs": {
                "low_poly": [UNWRAP, 0],
                "high_poly": [REMESH, 0],
                "resolution": shape.texture_size,
                "cage_distance": 0.05,
                "ignore_backfaces": True,
            },
        }
        apply_inputs["normal_map"] = [NORMALS, 0]
    if shape.bake_occlusion:
        graph[OCCLUSION] = {
            "class_type": "BakeAmbientOcclusion",
            "inputs": {
                "low_poly": [UNWRAP, 0],
                "high_poly": [REMESH, 0],
                # Occlusion is low frequency; half the colour map loses nothing.
                "resolution": max(256, shape.texture_size // 2),
                "samples": AO_SAMPLES,
                "max_distance": 0.71,
                "strength": 1.0,
                "bias": 0.01,
            },
        }
        apply_inputs["occlusion"] = [OCCLUSION, 0]

    graph[APPLY] = {"class_type": "ApplyTextureToMesh", "inputs": apply_inputs}
    graph[FINAL_SMOOTH] = {
        "class_type": "MeshSmoothNormals",
        "inputs": {"mesh": [APPLY, 0], "crease_angle": 180.0},
    }
    graph[SAVE] = {
        "class_type": "SaveGLB",
        "inputs": {"mesh": [FINAL_SMOOTH, 0], "filename_prefix": filename_prefix},
    }
    return graph

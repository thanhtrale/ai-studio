"""The Pixal3D image-to-textured-mesh workflow, in ComfyUI's API format.

Translated from Comfy-Org's own templates, `3d_pixal3d_trellis2_image_to_model`
(one image) and `3d_pixal3d_multi_views` (a fixed four-camera rig), as shipped
in `comfyui_workflow_templates_json` 0.1.96. The sampling is the templates':
the CFG intervals and rescales, the shift of 5 on the structure pass, the step
counts. The templates say why in a note of their own: "CFG override and
rescaleCFG to match the original pipeline".

Pixal3D (TencentARC, SIGGRAPH 2026, MIT) is TRELLIS.2's latent space with a
pixel-aligned conditioning: the mesh lands where the pixels of the input are,
which is what lets the character pipeline project the input's colours back
onto it afterwards (`reproject.py` in `rig-mia-skintokens`).

Two conditionings:

* **one image** (`views.front` only) -- `Pixal3DConditioning`, with the camera's
  field of view estimated by MoGe-2 from that image.
* **several views** -- `Pixal3DMultiViewConditioning` on a fixed rig of front,
  left, back and right cameras 90 degrees apart, at `fov` (20 by default). Any
  subset may be given; front is required. "left" is the character's own left
  side: the camera stands at its left and the character faces the left edge of
  the image.

Every view is cut out and cropped to its mask's bounding box at `pad`, so for a
character standing upright (taller than wide) the height sets the scale in
every view -- which is the condition the multi-view rig assumes.

Departures from the templates:

* No sheet-splitting branch: each view arrives as its own image.
* No preview or `Save3DAdvanced` nodes (the latter wants the UI's viewport);
  `SaveGLB` writes the file.
* Each view's cut-out and the baked base colour are saved beside the mesh, so a
  bad mesh can be traced to what the model was actually shown.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The camera rig, in the order `Pixal3DMultiViewConditioning` names its inputs.
VIEW_NAMES = ("front", "left", "back", "right")

#: The templates', per pass.
DEFAULT_STRUCTURE_STEPS = 12
DEFAULT_SHAPE_STEPS = 20
DEFAULT_REFINE_STEPS = 12
#: 24 was measured no better than 12 on the same seed (docs/log/char3d.md, r205/r206).
DEFAULT_TEXTURE_STEPS = 12
DEFAULT_CFG = 7.5
TEXTURE_CFG = 1.0
STRUCTURE_SHIFT = 5.0
STRUCTURE_CFG_UNTIL = 0.667
STRUCTURE_RESCALE = 0.7
SHAPE_CFG_UNTIL = 0.769
SHAPE_RESCALE = 0.5
STRUCTURE_RESOLUTION = "32"
SHAPE_RESOLUTIONS = (1024, 1536)
#: What the character pipeline was measured at.
DEFAULT_SHAPE_RESOLUTION = 1536
DEFAULT_REMESH_RESOLUTION = 768
REMESH_SMOOTH_ITERS = 20
#: The character pipeline's: the rig step decimates its own copy, and the
#: texture is baked onto this one.
DEFAULT_TARGET_FACES = 300_000
DEFAULT_TEXTURE_SIZE = 2048
DEFAULT_FOV = 20.0
DEFAULT_PAD = 1.1
CONDITION_EDGE = 1024
BACKGROUND = "#000000"
AO_SAMPLES = 64
AO_RESOLUTION = 1024
#: The normal map is capped: 4096 costs a lot of bake for detail the decimated
#: mesh cannot show.
NORMAL_MAP_CAP = 2048

#: Node ids, stable across jobs so ComfyUI's cache can reuse the loaders, the
#: cut-outs and the image encode between seeds.
UNET = "unet"
CLIP_VISION = "clip_vision"
SHAPE_VAE = "shape_vae"
TEXTURE_VAE = "texture_vae"
BG_MODEL = "bg_model"
MOGE_MODEL = "moge_model"
MOGE = "moge"
FOV = "fov"
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
MESH_INFO = "mesh_info"
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
SAVE_BASECOLOR = "save_basecolor"

#: The four samplers, in the order they run, with the stage name the report uses.
SAMPLERS: dict[str, str] = {
    STRUCTURE_SAMPLER: "structure",
    SHAPE_SAMPLER: "shape",
    REFINE_SAMPLER: "refine",
    TEXTURE_SAMPLER: "texture",
}


def view_node(kind: str, name: str) -> str:
    """`load_front`, `mask_front`, `crop_front`, `save_view_front`."""
    return f"{kind}_{name}"


#: What the timeline calls each node that does real work, in the order they
#: run. Per-view nodes are labelled in `labels_for`.
NODE_LABELS: dict[str, str] = {
    MOGE: "Estimate the camera (MoGe-2)",
    COND: "Encode the views (DINOv3)",
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
    """The named nodes this particular graph contains, views first."""
    labels: dict[str, str] = {}
    for name in VIEW_NAMES:
        if view_node("mask", name) in graph:
            labels[view_node("mask", name)] = f"Cut out the {name} view"
            labels[view_node("crop", name)] = f"Crop the {name} view"
    labels.update({node: label for node, label in NODE_LABELS.items() if node in graph})
    return labels


@dataclass
class Models:
    """The weight files, as bare filenames ComfyUI's loaders resolve."""

    single_model: str
    multiview_model: str
    clip_vision: str
    shape_vae: str
    texture_vae: str
    bg_model: str
    moge_model: str
    weight_dtype: str = "default"


@dataclass
class Shape:
    """One textured mesh's worth of work. Everything here comes from the job."""

    #: View name -> image, relative to ComfyUI's input directory.
    views: dict[str, str]
    seed: int
    structure_steps: int = DEFAULT_STRUCTURE_STEPS
    shape_steps: int = DEFAULT_SHAPE_STEPS
    refine_steps: int = DEFAULT_REFINE_STEPS
    texture_steps: int = DEFAULT_TEXTURE_STEPS
    structure_cfg: float = DEFAULT_CFG
    shape_cfg: float = DEFAULT_CFG
    shape_resolution: int = DEFAULT_SHAPE_RESOLUTION
    remesh_resolution: int = DEFAULT_REMESH_RESOLUTION
    target_faces: int = DEFAULT_TARGET_FACES
    texture_size: int = DEFAULT_TEXTURE_SIZE
    fov: float = DEFAULT_FOV
    pad: float = DEFAULT_PAD
    #: The UDF remesh builds a two-layer shell: an outer surface and an inner
    #: one wound the other way. Invisible at rest; once rigged, the inner layer
    #: pulls away where a sleeve bends. The templates leave both off, and so
    #: does the character pipeline: its rig step remeshes its own copy instead.
    drop_inverted: bool = False
    drop_enclosed: bool = False
    bake_normals: bool = True
    bake_occlusion: bool = True

    @property
    def multi(self) -> bool:
        return len(self.views) > 1


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
    if "front" not in shape.views:
        raise ValueError("the front view is required")
    unknown = set(shape.views) - set(VIEW_NAMES)
    if unknown:
        raise ValueError(f"unknown views: {', '.join(sorted(unknown))}")
    if shape.shape_resolution not in SHAPE_RESOLUTIONS:
        raise ValueError(f"shape resolution must be one of {SHAPE_RESOLUTIONS}")

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": models.multiview_model if shape.multi else models.single_model,
                "weight_dtype": models.weight_dtype,
            },
        },
        CLIP_VISION: {"class_type": "CLIPVisionLoader", "inputs": {"clip_name": models.clip_vision}},
        SHAPE_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.shape_vae}},
        TEXTURE_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.texture_vae}},
        BG_MODEL: {
            "class_type": "LoadBackgroundRemovalModel",
            "inputs": {"bg_removal_name": models.bg_model},
        },
    }

    # --- each view, cut out and cropped square ------------------------------
    crops: dict[str, list[Any]] = {}
    for name in VIEW_NAMES:
        image = shape.views.get(name)
        if not image:
            continue
        load, mask, crop = view_node("load", name), view_node("mask", name), view_node("crop", name)
        graph[load] = {"class_type": "LoadImage", "inputs": {"image": image}}
        graph[mask] = {
            "class_type": "RemoveBackground",
            "inputs": {"bg_removal_model": [BG_MODEL, 0], "image": [load, 0]},
        }
        graph[crop] = {
            "class_type": "ImageCropToMask",
            "inputs": {
                "images": [load, 0],
                "masks": [mask, 0],
                "width": CONDITION_EDGE,
                "height": CONDITION_EDGE,
                "pad_factor": shape.pad,
                "grow_mask": 0,
                "background": BACKGROUND,
            },
        }
        graph[view_node("save_view", name)] = {
            "class_type": "SaveImage",
            "inputs": {"images": [crop, 0], "filename_prefix": f"{filename_prefix}/view_{name}"},
        }
        crops[name] = [crop, 0]

    if shape.multi:
        graph[COND] = {
            "class_type": "Pixal3DMultiViewConditioning",
            "inputs": {"clip_vision_model": [CLIP_VISION, 0], "fov": shape.fov, **crops},
        }
    else:
        graph[MOGE_MODEL] = {"class_type": "LoadMoGeModel", "inputs": {"model_name": models.moge_model}}
        graph[MOGE] = {
            "class_type": "MoGeInference",
            "inputs": {
                "moge_model": [MOGE_MODEL, 0],
                "image": crops["front"],
                "resolution_level": 9,
                "fov_x_degrees": 0.0,
                "batch_size": 4,
                "force_projection": True,
                "apply_mask": True,
                "refine_steps": 3,
            },
        }
        graph[FOV] = {
            "class_type": "MoGeGeometryToFOV",
            "inputs": {"moge_geometry": [MOGE, 0], "axis": "horizontal", "unit": "degrees"},
        }
        graph[COND] = {
            "class_type": "Pixal3DConditioning",
            "inputs": {
                "clip_vision_model": [CLIP_VISION, 0],
                "image": crops["front"],
                "camera_angle_x": [FOV, 0],
            },
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
        shape.structure_cfg,
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
        SHAPE_MODEL, SHAPE_STAGE, [SHAPE_STAGE, 2], shape.seed, shape.shape_steps, shape.shape_cfg, "normal"
    )
    graph[UPSAMPLE] = {
        "class_type": "Trellis2UpsampleStage",
        "inputs": {
            "positive": [SHAPE_STAGE, 0],
            "negative": [SHAPE_STAGE, 1],
            "shape_latent": [SHAPE_SAMPLER, 0],
            "vae": [SHAPE_VAE, 0],
            "target_resolution": str(shape.shape_resolution),
        },
    }
    graph[REFINE_SAMPLER] = _sampler(
        SHAPE_MODEL, UPSAMPLE, [UPSAMPLE, 2], shape.seed, shape.refine_steps, shape.shape_cfg, "simple"
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

    # --- remesh, decimate, unwrap, bake -------------------------------------
    graph[MESH_INFO] = {"class_type": "GetMeshInfo", "inputs": {"mesh": [SHAPE_DECODE, 0]}}
    graph[REMESH] = {
        "class_type": "RemeshMesh",
        "inputs": {
            "mesh": [MESH_INFO, 0],
            "resolution": shape.remesh_resolution,
            # A dynamic combo: the option by name, its inputs as `<combo>.<input>`.
            "sign_mode": "udf",
            "sign_mode.qef": False,
            "sign_mode.drop_inverted_components": shape.drop_inverted,
            "sign_mode.drop_enclosed_components": shape.drop_enclosed,
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
            "reference_mesh": [SHAPE_DECODE, 0],
            "texture_size": shape.texture_size,
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
                "resolution": min(NORMAL_MAP_CAP, shape.texture_size),
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
                "resolution": AO_RESOLUTION,
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
        "inputs": {"mesh": [FINAL_SMOOTH, 0], "filename_prefix": f"{filename_prefix}/mesh"},
    }
    graph[SAVE_BASECOLOR] = {
        "class_type": "SaveImage",
        "inputs": {"images": [BAKE, 0], "filename_prefix": f"{filename_prefix}/basecolor"},
    }
    return graph

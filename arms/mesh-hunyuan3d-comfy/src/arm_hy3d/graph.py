"""The Hunyuan3D 2.1 image-to-shape workflow, in ComfyUI's API format.

ComfyUI's own `blueprints/Image to Model (Hunyuan3d 2.1).json` is the source for
the core of this graph -- the checkpoint loader, the AuraFlow shift at 1.0, the
4096-token latent, the 256 octree and the surface-net threshold of 0.6 -- because
a graph assembled from first principles would be a guess at what the
checkpoint was tuned against.

Two things the blueprint leaves to whoever prepared the image, added here:

* **The object is cut out.** Hunyuan3D was trained on renders of a single
  object on a plain background. A photograph's floor, wall and shadow are read
  as geometry, so BiRefNet masks the object and `ImageCropToMask` puts it,
  centred with a margin, on white -- which is also what the reference pipeline
  does before its DINOv2 encode.
* **The mesh is turned to face +Z.** Hunyuan3D puts an object's front along
  +X whatever angle the photograph was taken from; glTF, and so three.js,
  expects it along +Z, towards a default camera.
* **The mesh is decimated.** Surface nets at octree 256 produce hundreds of
  thousands of faces. That is right for a print and wrong for a page that
  three.js has to download and draw, so the face count is the job's to choose.

The output is an untextured GLB. Hunyuan3D's paint stage is not in ComfyUI.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The blueprint's sampling. The DiT is a flow model with shift 1.0.
DEFAULT_STEPS = 30
DEFAULT_CFG = 5.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "normal"
SHIFT = 1.0
#: Tokens in the shape latent. The blueprint's 4096; fewer is coarser.
DEFAULT_LATENT_TOKENS = 4096
#: Marching resolution of the decoded field. 256 is the blueprint's, 384 is
#: sharper and roughly 3.4x the decode time and memory.
DEFAULT_OCTREE = 256
#: Points the VAE decodes per chunk. Only memory, never the result.
DECODE_CHUNKS = 8000
SURFACE_THRESHOLD = 0.6
#: The image DINOv2 sees. Square, because it is centre-cropped to 518 anyway,
#: and cropping the object here is better than letting the encoder crop it.
CONDITION_EDGE = 1024
#: Margin around the object's mask. The reference pipeline leaves 15%.
CROP_PAD = 1.15
BACKGROUND = "#FFFFFF"
#: Degrees about +Y that take Hunyuan3D's front (+X) to glTF's (+Z). Measured
#: on a chair whose front is unambiguous, not taken from a paper.
FRONT_YAW = -90.0

#: Node ids. Strings because that is what ComfyUI's API format uses as keys,
#: and stable across jobs because ComfyUI caches a node's output by id and
#: inputs -- a renamed node would reload a checkpoint that has not changed.
CKPT = "ckpt"
SHIFTED = "shift"
REF = "ref"
BG_MODEL = "bg_model"
MASK = "mask"
CUTOUT = "cutout"
VISION = "vision"
COND = "cond"
LATENT = "latent"
SAMPLER = "sampler"
DECODE = "decode"
MESH = "mesh"
ORIENT = "orient"
DECIMATE = "decimate"
SAVE = "save"


#: What the timeline calls each node that does real work, in the order they
#: run. The loaders and the sampling patch are instant and left unnamed.
NODE_LABELS: dict[str, str] = {
    MASK: "Cut out the object",
    CUTOUT: "Crop to the object",
    VISION: "Encode the image (DINOv2)",
    SAMPLER: "Sample shape",
    DECODE: "Decode the field",
    MESH: "Extract the surface",
    ORIENT: "Turn to face +Z",
    DECIMATE: "Decimate",
    SAVE: "Write GLB",
}


def labels_for(graph: dict[str, Any]) -> dict[str, str]:
    """The named nodes this particular graph contains."""
    return {node: label for node, label in NODE_LABELS.items() if node in graph}


@dataclass
class Models:
    """The weight files, as bare filenames ComfyUI's loaders resolve."""

    checkpoint: str
    bg_model: str


@dataclass
class Shape:
    """One mesh's worth of work. Everything here comes from the job."""

    reference: str
    seed: int
    steps: int = DEFAULT_STEPS
    cfg: float = DEFAULT_CFG
    sampler: str = DEFAULT_SAMPLER
    scheduler: str = DEFAULT_SCHEDULER
    latent_tokens: int = DEFAULT_LATENT_TOKENS
    octree: int = DEFAULT_OCTREE
    #: Faces to decimate to. 0 keeps whatever surface nets produced.
    target_faces: int = 0
    remove_background: bool = True


def build(models: Models, shape: Shape, filename_prefix: str) -> dict[str, Any]:
    """The whole graph for one mesh, ready to POST to `/prompt`."""
    graph: dict[str, Any] = {
        CKPT: {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": models.checkpoint}},
        SHIFTED: {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": [CKPT, 0], "shift": SHIFT},
        },
        REF: {"class_type": "LoadImage", "inputs": {"image": shape.reference}},
    }

    condition_source: list[Any] = [REF, 0]
    if shape.remove_background:
        graph[BG_MODEL] = {
            "class_type": "LoadBackgroundRemovalModel",
            "inputs": {"bg_removal_name": models.bg_model},
        }
        graph[MASK] = {
            "class_type": "RemoveBackground",
            "inputs": {"bg_removal_model": [BG_MODEL, 0], "image": [REF, 0]},
        }
        graph[CUTOUT] = {
            "class_type": "ImageCropToMask",
            "inputs": {
                "images": [REF, 0],
                "masks": [MASK, 0],
                "width": CONDITION_EDGE,
                "height": CONDITION_EDGE,
                "pad_factor": CROP_PAD,
                "grow_mask": 0,
                "background": BACKGROUND,
            },
        }
        condition_source = [CUTOUT, 0]

    graph[VISION] = {
        "class_type": "CLIPVisionEncode",
        "inputs": {"clip_vision": [CKPT, 1], "image": condition_source, "crop": "center"},
    }
    graph[COND] = {"class_type": "Hunyuan3Dv2Conditioning", "inputs": {"clip_vision_output": [VISION, 0]}}
    graph[LATENT] = {
        "class_type": "EmptyLatentHunyuan3Dv2",
        "inputs": {"resolution": shape.latent_tokens, "batch_size": 1},
    }
    graph[SAMPLER] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [SHIFTED, 0],
            "positive": [COND, 0],
            "negative": [COND, 1],
            "latent_image": [LATENT, 0],
            "seed": shape.seed,
            "steps": shape.steps,
            "cfg": shape.cfg,
            "sampler_name": shape.sampler,
            "scheduler": shape.scheduler,
            "denoise": 1.0,
        },
    }
    graph[DECODE] = {
        "class_type": "VAEDecodeHunyuan3D",
        "inputs": {
            "samples": [SAMPLER, 0],
            "vae": [CKPT, 2],
            "num_chunks": DECODE_CHUNKS,
            "octree_resolution": shape.octree,
        },
    }
    graph[MESH] = {
        "class_type": "VoxelToMesh",
        "inputs": {"voxel": [DECODE, 0], "algorithm": "surface net", "threshold": SURFACE_THRESHOLD},
    }

    # A dynamic combo in the API format: the option by its own name, and each of
    # its inputs as `<combo>.<input>`.
    graph[ORIENT] = {
        "class_type": "RotateMesh",
        "inputs": {
            "mesh": [MESH, 0],
            "mode": "euler_xyz",
            "mode.angle_x": 0.0,
            "mode.angle_y": FRONT_YAW,
            "mode.angle_z": 0.0,
        },
    }

    mesh_source: list[Any] = [ORIENT, 0]
    if shape.target_faces > 0:
        graph[DECIMATE] = {
            "class_type": "DecimateMesh",
            "inputs": {
                "mesh": [ORIENT, 0],
                "target_face_count": shape.target_faces,
                # "midpoint" is the node's recommended preset and has no
                # sub-inputs; "qem" would need four more keys spelled
                # `placement_mode.<name>`.
                "placement_mode": "midpoint",
            },
        }
        mesh_source = [DECIMATE, 0]

    graph[SAVE] = {
        "class_type": "SaveGLB",
        "inputs": {"mesh": mesh_source, "filename_prefix": filename_prefix},
    }
    return graph

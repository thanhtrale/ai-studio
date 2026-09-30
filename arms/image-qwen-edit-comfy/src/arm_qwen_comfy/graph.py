"""The Qwen-Image-Edit workflow, in ComfyUI's API format.

ComfyUI's own `blueprints/Image Edit (Qwen 2511).json` is the source for this
shape -- the loaders, the AuraFlow shift, the CFG norm, the reference-latent
method -- because a graph assembled from first principles would be a guess at
what the checkpoint was tuned against.

Two deliberate departures from the blueprint:

* The latent is empty, at the size the job asked for, rather than a VAE encode
  of the first reference. The blueprint denoises at strength 1.0 from the
  reference's own shape, which makes the output size unchooseable; an empty
  latent at full denoise is the same sampling problem with the frame under the
  console's control.
* One image per prompt, never a batch dimension. ComfyUI derives a batch's
  noise from a single seed, so a batch of four has one seed for four files and
  no way to reproduce the third on its own. Queuing four prompts with four
  seeds costs nothing extra -- the text encode is cached across them -- and
  every file gets a seed the library can record and replay.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: `TextEncodeQwenImageEditPlus` takes image1..image3 and no more.
MAX_REFERENCES = 3

#: What the 2511 blueprint ships with. Not defaults the console has to send.
DEFAULT_SHIFT = 3.1
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
#: How several references are spliced into the sequence. The blueprint's choice.
REFERENCE_METHOD = "index_timestep_zero"
#: `CFGNorm` at strength 1: the blueprint's, and what keeps a high CFG from
#: blowing out on this checkpoint.
CFG_NORM_STRENGTH = 1.0

#: Node ids. Strings because that is what ComfyUI's API format uses as keys,
#: and stable across jobs because ComfyUI caches a node's output by id and
#: inputs -- a renamed node would re-encode a prompt that has not changed.
UNET = "unet"
CLIP = "clip"
VAE = "vae"
SHIFT = "shift"
CFGNORM = "cfgnorm"
POSITIVE = "positive"
NEGATIVE = "negative"
POSITIVE_REF = "positive_ref"
NEGATIVE_REF = "negative_ref"
LATENT = "latent"
SAMPLER = "sampler"
DECODE = "decode"
SAVE = "save"


@dataclass
class Models:
    """The three weight files, named as ComfyUI's loaders name them.

    Bare filenames, not paths: ComfyUI resolves them against the search paths
    this arm writes into its `extra_model_paths.yaml`, so the graph never
    carries a location the child could be pointed at.
    """

    unet: str
    clip: str
    vae: str
    weight_dtype: str = "fp8_e4m3fn"
    clip_device: str = "default"


@dataclass
class Sampling:
    """One image's worth of sampling. Everything here comes from the job."""

    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    cfg: float
    seed: int
    sampler: str = DEFAULT_SAMPLER
    scheduler: str = DEFAULT_SCHEDULER
    shift: float = DEFAULT_SHIFT
    #: Reference images, named relative to ComfyUI's input directory.
    references: list[str] = field(default_factory=list)


def _text_encode(
    clip_source: str, prompt: str, references: list[str], scale_first: bool
) -> dict[str, Any]:
    inputs: dict[str, Any] = {"clip": [clip_source, 0], "prompt": prompt}
    if references:
        inputs["vae"] = [VAE, 0]
        for index, _ in enumerate(references):
            source = f"scale{index}" if (scale_first and index == 0) else f"ref{index}"
            inputs[f"image{index + 1}"] = [source, 0]
    return {"class_type": "TextEncodeQwenImageEditPlus", "inputs": inputs}


def build(models: Models, sampling: Sampling, filename_prefix: str) -> dict[str, Any]:
    """The whole graph for one image, ready to POST to `/prompt`.

    With no references this is plain text-to-image: the edit encoder is still
    the right one -- it is the only text encoder these weights were trained
    with -- but the reference-latent plumbing has nothing to carry and is left
    out rather than wired to nothing.
    """
    if len(sampling.references) > MAX_REFERENCES:
        raise ValueError(f"at most {MAX_REFERENCES} reference images")

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models.unet, "weight_dtype": models.weight_dtype},
        },
        CLIP: {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": models.clip,
                "type": "qwen_image",
                "device": models.clip_device,
            },
        },
        VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.vae}},
        SHIFT: {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": [UNET, 0], "shift": sampling.shift},
        },
        CFGNORM: {
            "class_type": "CFGNorm",
            "inputs": {"model": [SHIFT, 0], "strength": CFG_NORM_STRENGTH},
        },
        LATENT: {
            "class_type": "EmptySD3LatentImage",
            "inputs": {"width": sampling.width, "height": sampling.height, "batch_size": 1},
        },
        DECODE: {"class_type": "VAEDecode", "inputs": {"samples": [SAMPLER, 0], "vae": [VAE, 0]}},
        SAVE: {
            "class_type": "SaveImage",
            "inputs": {"images": [DECODE, 0], "filename_prefix": filename_prefix},
        },
    }

    for index, reference in enumerate(sampling.references):
        graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": reference}}

    # Only the first reference is scaled. It is the one the edit is anchored
    # to, and Kontext's resolution table is about the frame being produced
    # rather than about every image the encoder happens to see.
    if sampling.references:
        graph["scale0"] = {"class_type": "FluxKontextImageScale", "inputs": {"image": ["ref0", 0]}}

    graph[POSITIVE] = _text_encode(CLIP, sampling.prompt, sampling.references, scale_first=True)
    graph[NEGATIVE] = _text_encode(
        CLIP, sampling.negative_prompt, sampling.references, scale_first=True
    )

    positive_source, negative_source = POSITIVE, NEGATIVE
    if sampling.references:
        graph[POSITIVE_REF] = {
            "class_type": "FluxKontextMultiReferenceLatentMethod",
            "inputs": {
                "conditioning": [POSITIVE, 0],
                "reference_latents_method": REFERENCE_METHOD,
            },
        }
        graph[NEGATIVE_REF] = {
            "class_type": "FluxKontextMultiReferenceLatentMethod",
            "inputs": {
                "conditioning": [NEGATIVE, 0],
                "reference_latents_method": REFERENCE_METHOD,
            },
        }
        positive_source, negative_source = POSITIVE_REF, NEGATIVE_REF

    graph[SAMPLER] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [CFGNORM, 0],
            "positive": [positive_source, 0],
            "negative": [negative_source, 0],
            "latent_image": [LATENT, 0],
            "seed": sampling.seed,
            "steps": sampling.steps,
            "cfg": sampling.cfg,
            "sampler_name": sampling.sampler,
            "scheduler": sampling.scheduler,
            "denoise": 1.0,
        },
    }

    return graph

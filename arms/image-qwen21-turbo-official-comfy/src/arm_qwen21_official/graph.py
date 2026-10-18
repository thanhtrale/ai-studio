"""The official Qwen-Image-2.1-Turbo workflow, in ComfyUI's API format.

The shape of ComfyUI's own `image_qwen_image_2_1_t2i` / `_image_edit` templates
with the subgraph flattened, the prompt-enhancer branch left to its own graph,
and the KSampler replaced by `SamplerCustomAdvanced` so the schedule has one
socket to go into.

Qwen-Image-2.1-Turbo (Qwen, released 2026-10-09) is the base model distilled to
eight unguided steps -- a checkpoint of its own, not a LoRA. Comfy-Org's
`qwen_image_2.1_turbo_int8_convrot` is quantised straight from it, so nothing
is applied at runtime and no custom node is needed.

**The schedule is fixed.** `model_index.json` of `Qwen/Qwen-Image-2.1-Turbo`
lists `sample_sigmas`; diffusers (PR #14950) hands that list to
`FlowMatchEulerDiscreteScheduler.set_timesteps(sigmas=...)`, and the
checkpoint's scheduler has `use_dynamic_shifting: false` and `shift: 1.0`, so
the shift is the identity: the pipeline computes `mu` from the frame and the
scheduler ignores it. The list goes into `ManualSigmas` as it is, plus the
closing 0. This is the opposite of viggle-turbo, whose raw nodes are shifted by
the frame's token count -- do not share a sigma function between the two arms.

The prompt rewriter is a second, much smaller graph, on the same text encoder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: `TextEncodeQwenImage21` grows `image_1` .. `image_16`; three is what the
#: studio's routes allow and what the character pipeline was measured with.
MAX_REFERENCES = 3

#: `sample_sigmas` from Qwen/Qwen-Image-2.1-Turbo's `model_index.json`,
#: without the closing 0.
TURBO_SIGMAS = (1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568)
#: One transformer pass per sigma. Not a knob: there is no rule for another count.
DEFAULT_STEPS = len(TURBO_SIGMAS)

DEFAULT_SAMPLER = "euler"
#: Reference images are seen by the text encoder and spliced in as latents at
#: about this area. The base template's own default.
REFERENCE_RESOLUTION = 1024

UNET = "unet"
CACHE = "cache"
CLIP = "clip"
VAE = "vae"
ENCODE = "encode"
LATENT = "latent"
GUIDER = "guider"
NOISE = "noise"
SAMPLER_SELECT = "sampler_select"
SIGMAS = "sigmas"
SAMPLER = "sampler"
DECODE = "decode"
SAVE = "save"

REWRITE_GENERATE = "rewrite_generate"
REWRITE_OUT = "rewrite_out"
REWRITE_BATCH = "rewrite_batch"


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
    #: The int8 file is already quantised and wants "default".
    weight_dtype: str = "default"
    clip_device: str = "default"
    kv_cache_device: str = "auto"
    kv_cache_dtype: str = "default"


@dataclass
class Sampling:
    """One image's worth of sampling. Everything here comes from the job."""

    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    seed: int
    sampler: str = DEFAULT_SAMPLER
    #: Reference images, named relative to ComfyUI's input directory.
    references: list[str] = field(default_factory=list)


def turbo_sigmas() -> str:
    """The schedule as `ManualSigmas` reads it: fixed-point decimals and a closing 0.

    Fixed-point because the node's parser does not read `1e-05`.
    """
    return ", ".join(f"{value:.8f}" for value in (*TURBO_SIGMAS, 0.0))


def _reference_inputs(references: list[str]) -> dict[str, Any]:
    """One image input per reference, keyed the way autogrow expands.

    `TextEncodeQwenImage21` declares a single growable input called `images`,
    and ComfyUI matches its rows on the dotted path rather than on the bare
    name -- a flat `image_1` reaches `execute` as an unexpected keyword and the
    prompt is refused.
    """
    return {f"images.image_{index + 1}": [f"ref{index}", 0] for index in range(len(references))}


def build(models: Models, sampling: Sampling, filename_prefix: str) -> dict[str, Any]:
    """The whole graph for one image, ready to POST to `/prompt`."""
    if len(sampling.references) > MAX_REFERENCES:
        raise ValueError(f"at most {MAX_REFERENCES} reference images")

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models.unet, "weight_dtype": models.weight_dtype},
        },
        CACHE: {
            "class_type": "QwenImage21Cache",
            "inputs": {
                "model": [UNET, 0],
                "device": models.kv_cache_device,
                "dtype": models.kv_cache_dtype,
            },
        },
        CLIP: {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": models.clip,
                # Still `qwen_image`: the loader decides Qwen-Image 2.1 from
                # the encoder being Qwen3-VL 8B rather than from this value.
                "type": "qwen_image",
                "device": models.clip_device,
            },
        },
        VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.vae}},
        ENCODE: {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": [CLIP, 0],
                "prompt": sampling.prompt,
                # Carried even though nothing reads it: with no guidance there
                # is no negative branch to steer away from, and a job that sent
                # one should see it in the graph it produced rather than
                # wonder where it went.
                "negative_prompt": sampling.negative_prompt,
                "resolution": REFERENCE_RESOLUTION,
                **({"vae": [VAE, 0]} if sampling.references else {}),
                **_reference_inputs(sampling.references),
            },
        },
        LATENT: {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": sampling.width, "height": sampling.height, "batch_size": 1},
        },
        GUIDER: {
            # No CFG: the Turbo card's default is 1, and at 1 ComfyUI skips the
            # unconditional pass altogether.
            "class_type": "BasicGuider",
            "inputs": {"model": [CACHE, 0], "conditioning": [ENCODE, 0]},
        },
        NOISE: {"class_type": "RandomNoise", "inputs": {"noise_seed": sampling.seed}},
        SAMPLER_SELECT: {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": sampling.sampler},
        },
        SIGMAS: {"class_type": "ManualSigmas", "inputs": {"sigmas": turbo_sigmas()}},
        SAMPLER: {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": [NOISE, 0],
                "guider": [GUIDER, 0],
                "sampler": [SAMPLER_SELECT, 0],
                "sigmas": [SIGMAS, 0],
                "latent_image": [LATENT, 0],
            },
        },
        DECODE: {"class_type": "VAEDecode", "inputs": {"samples": [SAMPLER, 0], "vae": [VAE, 0]}},
        SAVE: {
            "class_type": "SaveImage",
            "inputs": {"images": [DECODE, 0], "filename_prefix": filename_prefix},
        },
    }

    for index, reference in enumerate(sampling.references):
        graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": reference}}

    return graph


def build_rewrite(
    models: Models, prompt: str, system_prompt: str, references: list[str]
) -> dict[str, Any]:
    """The prompt rewriter, as a graph of its own.

    The same Qwen3-VL encoder the image graph loads, generating text instead of
    conditioning -- which is why the enhancer costs no extra model on the card.
    Its answer leaves through `PreviewAny`, the one node that puts a string
    into `/history` where this arm can read it.

    Sampling is off, so a prompt rewrites to the same thing every time and a
    repeated job reproduces.
    """
    graph: dict[str, Any] = {
        CLIP: {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": models.clip,
                "type": "qwen_image",
                "device": models.clip_device,
            },
        },
        REWRITE_GENERATE: {
            "class_type": "TextGenerate",
            "inputs": {
                "clip": [CLIP, 0],
                "prompt": prompt,
                "system_prompt": system_prompt,
                "max_length": 1024,
                "sampling_mode": "off",
                "thinking": False,
                "use_default_template": True,
                "mtp": "auto",
            },
        },
        REWRITE_OUT: {"class_type": "PreviewAny", "inputs": {"source": [REWRITE_GENERATE, 0]}},
    }

    if references:
        for index, reference in enumerate(references):
            graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": reference}}
        # The edit rewriter is shown the references it is describing, and
        # `TextGenerate` takes them as one batch. `BatchImagesNode` grows from
        # a zero-based prefix, under the same dotted path rule.
        graph[REWRITE_BATCH] = {
            "class_type": "BatchImagesNode",
            "inputs": {
                f"images.image{index}": [f"ref{index}", 0] for index in range(len(references))
            },
        }
        graph[REWRITE_GENERATE]["inputs"]["image"] = [REWRITE_BATCH, 0]

    return graph

"""The Qwen-Image 2.1 turbo workflow, in ComfyUI's API format.

Taken from the two workflows Viggle ships with the LoRA
(`comfyui/Qwen-Image-2.1-viggle-turbo-{t2i,edit}.json`) rather than assembled
from first principles: the sampler here is not a KSampler at all, and the
reason is specific to this LoRA.

viggle-turbo is a distribution-matching distillation of the forty-step base
model into six transformer passes. It was trained to land on particular noise
levels, so it is sampled on an explicit sigma schedule -- `ViggleTurboSigmas`,
which applies the pipeline's resolution-dependent shift to those nodes -- and
with no classifier-free guidance at all, which is why the model reaches a
`BasicGuider` rather than a KSampler's positive/negative pair. The LoRA is
applied unmerged, because merging it into bf16 weights loses about a third of
the update.

The prompt rewriter is a second, much smaller graph. It runs as its own
ComfyUI prompt so that a rewrite that comes back malformed is a Python problem
with a message, rather than an empty string quietly reaching the sampler.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: `TextEncodeQwenImage21` grows `image_1` .. `image_16`, but viggle-turbo was
#: trained on at most three references and the README says so.
MAX_REFERENCES = 3

#: The schedule the v0.2.1 LoRA was shipped with, and the number of steps that
#: produces it. Both are defaults, not limits -- see `sigma_nodes`.
DEFAULT_STEPS = 6
#: Everything below 0.875 is where the student was trained to land. Extra steps
#: are added at the high-noise end only; moving these makes every image softer.
SIGMA_TAIL = (0.875, 0.75, 0.5, 0.25)
#: `num_inference_steps=4` with no explicit schedule is the training schedule.
SIGMA_TRAINING = (1.0, 0.75, 0.5, 0.25)

DEFAULT_SAMPLER = "euler"
#: Reference images are seen by the text encoder and spliced in as latents at
#: about this area. The base template's own default.
REFERENCE_RESOLUTION = 1024

UNET = "unet"
LORA = "lora"
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
    """The four weight files, named as ComfyUI's loaders name them.

    Bare filenames, not paths: ComfyUI resolves them against the search paths
    this arm writes into its `extra_model_paths.yaml`, so the graph never
    carries a location the child could be pointed at.
    """

    unet: str
    clip: str
    vae: str
    lora: str
    weight_dtype: str = "fp8_e4m3fn"
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


def sigma_nodes(steps: int) -> list[float]:
    """The raw sigma schedule for a step count, per the LoRA's own rules.

    Four steps is the schedule the student was trained on. Above that, the
    nodes below 0.875 are fixed -- they are the ones it learned to land on --
    and the extra steps subdivide the first, highest-noise segment, where one
    big Euler step is what ghosts and drifts a composition.
    """
    if steps <= 4:
        return list(SIGMA_TRAINING)

    head_count = steps - len(SIGMA_TAIL)
    top, first_tail = 1.0, SIGMA_TAIL[0]
    head = [top - (top - first_tail) * index / head_count for index in range(head_count)]
    return [round(value, 6) for value in head] + list(SIGMA_TAIL)


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

    nodes = ", ".join(f"{value:g}" for value in sigma_nodes(sampling.steps))

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models.unet, "weight_dtype": models.weight_dtype},
        },
        LORA: {
            "class_type": "ViggleTurboLora",
            # Strength stays at 1.0: the adapter's alpha equals its rank, and
            # the README is explicit that anything else is a mistake.
            "inputs": {"model": [UNET, 0], "lora_name": models.lora, "strength": 1.0},
        },
        CACHE: {
            "class_type": "QwenImage21Cache",
            "inputs": {
                "model": [LORA, 0],
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
            # No CFG. The student was distilled to run unguided, and the README
            # measured guidance as no help at any scale.
            "class_type": "BasicGuider",
            "inputs": {"model": [CACHE, 0], "conditioning": [ENCODE, 0]},
        },
        NOISE: {"class_type": "RandomNoise", "inputs": {"noise_seed": sampling.seed}},
        SAMPLER_SELECT: {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": sampling.sampler},
        },
        SIGMAS: {
            # Reads the latent to size the resolution-dependent shift, which is
            # why it is given the same latent the sampler gets.
            "class_type": "ViggleTurboSigmas",
            "inputs": {"latent": [LATENT, 0], "nodes": nodes},
        },
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

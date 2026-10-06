"""MiniMax-H3 with the Turbo LoRA, as a ComfyUI graph in its API format.

Taken from the workflow Larryvrh ships with the LoRA
(`example_workflows/minimax_h3_t2v_turbo.json`) rather than assembled from
first principles, for the same reason the Qwen arm's graph is: the sampler is
not a `KSampler` and the reason is specific to this model.

H3 denoises picture and stereo audio as one packed latent, and the two streams
ride different flow schedules -- video shift 12, audio shift 3. Recent ComfyUI
carries that natively through `ModelSamplingAV`, older ComfyUI does not, and a
stock sampler on an old build over-steps the audio badly at four steps. The
node's `MiniMaxH3TurboSampler` detects which build it is on and does the right
thing either way, which is why the graph asks for it rather than for
`KSamplerSelect`.

There is no classifier-free guidance: the released checkpoints are already
CFG-distilled, so the model reaches a `BasicGuider` rather than a positive and
negative pair, and a negative prompt has nothing to steer away from.

The LoRA is applied unmerged by default. Merging a low-rank update back into an
int8 base requantises it away, which is the whole difference between the
`bypass` and `merge` modes the arm exposes.

Two modes, two checkpoints, one graph shape. `fl2v` is the `fl2va` weights
under `MiniMaxH3ImageToVideo` -- text alone, or a first and a last frame.
`ref2v` is the `ref2va` weights under `MiniMaxH3ReferenceToVideo` -- up to
nine stills the prompt cites as `<Picture 1>` ... `<Picture 9>`, which the clip
is about rather than which it starts or ends on. Everything downstream of the
conditioning node -- the LoRA, the shift, the sampler, the two decoders -- is
the same in both.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: `MiniMaxH3ImageToVideo` takes a first frame, a last frame, or both.
MAX_KEYFRAMES = 2

#: `MiniMaxH3ReferenceToVideo` grows up to nine image inputs. Reference clips
#: and voices are the same node's other inputs, and the studio has no way to
#: send either yet.
MAX_REFERENCES = 9

#: The two tasks this arm runs, by the name the console shows. Each is its own
#: checkpoint and its own conditioning node.
MODES = ("fl2v", "ref2v")
DEFAULT_MODE = "fl2v"

#: How `ref2v` sizes a reference before it encodes it. `match` scales each one
#: down to the clip's own pixel area; `max` keeps a 2048 short edge for
#: identity, and the reference tokens ride through every sampling step, so it
#: is several times slower.
REF_IMAGE_SIZES = ("match", "max")
DEFAULT_REF_IMAGE_SIZE = "match"

#: Four is the LoRA's floor and eight its ceiling; six is where its own README
#: puts the knee. Past eight it stops helping and starts over-sharpening.
DEFAULT_STEPS = 6
MIN_STEPS = 1
MAX_STEPS = 32

#: `simple` is what the LoRA was tuned against. `BasicScheduler` takes a named
#: scheduler rather than raw sigmas, so this is a name and not a schedule.
DEFAULT_SCHEDULER = "simple"

#: The adapter's alpha equals its rank, so 1.0 is the identity of its own
#: scaling. Its README is explicit that anything else is a last resort.
LORA_STRENGTH = 1.0

#: H3's two flow schedules, as `MiniMaxH3SigmaShift` defaults them. The video
#: shift drives the sampler's sigmas; the audio one is derived from it inside
#: the transformer, which is why they have to move together.
DEFAULT_SHIFT_VIDEO = 12.0
DEFAULT_SHIFT_AUDIO = 3.0

#: The model's own grids. Both are hard: the VAE is a sixteenth scale with a
#: further 2x2 patchify, and the temporal pack is five frames plus blocks of
#: seventeen.
CANVAS_MULTIPLE = 32
FRAME_BLOCK = 17
FRAME_OFFSET = 5
#: 24 fps is not a setting. The clip's audio latents are sized from its
#: duration in seconds, and the model was trained at one frame rate.
FPS = 24

#: The native canvas: a 768-pixel short edge, capped at this area. Past it the
#: model is being asked for a resolution it was not trained at -- 2K comes from
#: H3-Regenerate-2K, which is not part of the open release.
BASE_SHORT_EDGE = 768
MAX_PIXELS = 768 * 1344

OUTPUT_FORMAT = "mp4"

UNET = "unet"
LORA = "lora"
SHIFT = "shift"
CLIP = "clip"
VIDEO_VAE = "video_vae"
AUDIO_VAE = "audio_vae"
COND = "cond"
GUIDER = "guider"
NOISE = "noise"
SAMPLER_SELECT = "sampler_select"
SIGMAS = "sigmas"
SAMPLER = "sampler"
DECODE_VIDEO = "decode_video"
DECODE_AUDIO = "decode_audio"
CREATE = "create"
SAVE = "save"

#: Which nodes are worth a line on the studio's timeline, and what to call
#: them. Keyed by the ids this module gives its own nodes, which is what makes
#: ComfyUI's `executing` events readable as phases rather than as graph
#: bookkeeping. The loaders are deliberately absent: they are instantaneous,
#: and the load that costs minutes happens inside the node that first needs
#: the weights -- so it files itself under that phase instead.
PHASES: dict[str, str] = {
    COND: "Encode prompt",
    SAMPLER: "Denoise",
    DECODE_VIDEO: "Decode video",
    DECODE_AUDIO: "Decode audio",
    CREATE: "Mux video and audio",
    SAVE: "Write the file",
}


@dataclass
class Models:
    """The five weight files, named as ComfyUI's loaders name them.

    Bare filenames, not paths: ComfyUI resolves them against the search paths
    this arm writes into its `extra_model_paths.yaml`, so the graph never
    carries a location the child could be pointed at.
    """

    unet: str
    clip: str
    video_vae: str
    audio_vae: str
    lora: str
    #: The `ref2va` checkpoint, for `ref2v` jobs. Empty means the arm was
    #: started without one, and a `ref2v` job is refused before it is queued.
    ref_unet: str = ""
    weight_dtype: str = "default"
    clip_device: str = "default"
    #: "bypass" applies the LoRA at run time, "merge" folds it into the
    #: weights. The node spells the second one `low_vram`.
    lora_mode: str = "bypass"

    @property
    def merge_lora(self) -> bool:
        return self.lora_mode == "merge"


@dataclass
class Sampling:
    """One clip's worth of sampling. Everything here comes from the job."""

    prompt: str
    negative_prompt: str
    width: int
    height: int
    num_frames: int
    steps: int
    seed: int
    scheduler: str = DEFAULT_SCHEDULER
    shift_video: float = DEFAULT_SHIFT_VIDEO
    shift_audio: float = DEFAULT_SHIFT_AUDIO
    #: The first frame, then the last, named relative to ComfyUI's input
    #: directory. Positional: the second slot is the *last* frame, so a job
    #: that wants only an ending has to say so rather than send one image.
    #: `ref2v` reads the same list as `<Picture 1>`, `<Picture 2>` ... instead.
    keyframes: list[str] = field(default_factory=list)
    mode: str = DEFAULT_MODE
    ref_image_size: str = DEFAULT_REF_IMAGE_SIZE


def align_frames(length: int) -> int:
    """The nearest frame count at or above `length` that the model accepts.

    `17k + 5`, which is what the temporal pack decomposes into: five frames in
    the first latent block and seventeen in each one after it. The node rounds
    up internally too, but rounding here is what lets the console show the
    duration it is actually going to get.
    """
    frames = max(FRAME_OFFSET, int(length))
    return frames + (FRAME_OFFSET - frames % FRAME_BLOCK) % FRAME_BLOCK


def frames_for_seconds(seconds: float) -> int:
    """A duration in seconds as a frame count on the model's grid."""
    return align_frames(round(max(0.0, seconds) * FPS))


def native_canvas(width: int, height: int) -> tuple[int, int]:
    """The same frame at the model's native scale: 768 short edge, area capped.

    Not applied to a job -- a job's size is the job's business -- but it is the
    number a console wants to show beside a frame that is much larger or much
    smaller than anything the model saw in training.
    """
    ratio = max(1e-6, width / max(1, height))
    if ratio >= 1.0:
        nominal_w, nominal_h = BASE_SHORT_EDGE * ratio, float(BASE_SHORT_EDGE)
    else:
        nominal_w, nominal_h = float(BASE_SHORT_EDGE), BASE_SHORT_EDGE / ratio

    area = nominal_w * nominal_h
    if area > MAX_PIXELS:
        scale = (MAX_PIXELS / area) ** 0.5
        nominal_w, nominal_h = nominal_w * scale, nominal_h * scale

    return _snap(nominal_w), _snap(nominal_h)


def _snap(value: float) -> int:
    return max(CANVAS_MULTIPLE, round(value / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)


def _keyframe_inputs(keyframes: list[str]) -> dict[str, Any]:
    """`first_frame` and `last_frame`, wired only when the job sent them.

    Both are optional inputs on the node. Passing a null would be a link to
    nothing and ComfyUI refuses the prompt, so an absent keyframe is an absent
    key.
    """
    names = ("first_frame", "last_frame")
    return {names[index]: [f"keyframe{index}", 0] for index in range(len(keyframes))}


def _reference_inputs(references: list[str]) -> dict[str, Any]:
    """`ref_images.ref_image_0` ... as an API prompt spells an autogrow input.

    The node's inputs are dynamic: ComfyUI names each grown slot by its path
    under the group, dotted, and builds the nested dict the node receives from
    those names. A slot that is not sent simply does not exist.
    """
    return {f"ref_images.ref_image_{index}": [f"reference{index}", 0] for index in range(len(references))}


def _conditioning(sampling: Sampling) -> dict[str, Any]:
    if sampling.mode == "ref2v":
        return {
            # The audio VAE is wired as well as the video one: the node encodes
            # reference audio through it, and wiring it now means a voice
            # reference is an input away rather than a graph change away.
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "clip": [CLIP, 0],
                "vae": [VIDEO_VAE, 0],
                "audio_vae": [AUDIO_VAE, 0],
                "prompt": sampling.prompt,
                "width": sampling.width,
                "height": sampling.height,
                "length": align_frames(sampling.num_frames),
                "ref_image_size": sampling.ref_image_size,
                **_reference_inputs(sampling.keyframes),
            },
        }
    return {
        # One node for both t2va and fl2va: with no keyframe it is
        # text-to-video, with one or two it is first/last-frame video.
        "class_type": "MiniMaxH3ImageToVideo",
        "inputs": {
            "clip": [CLIP, 0],
            "vae": [VIDEO_VAE, 0],
            "prompt": sampling.prompt,
            "width": sampling.width,
            "height": sampling.height,
            "length": align_frames(sampling.num_frames),
            **_keyframe_inputs(sampling.keyframes),
        },
    }


def build(models: Models, sampling: Sampling, filename_prefix: str) -> dict[str, Any]:
    """The whole graph for one clip, ready to POST to `/prompt`."""
    if sampling.mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    if sampling.mode == "fl2v" and len(sampling.keyframes) > MAX_KEYFRAMES:
        raise ValueError(f"at most {MAX_KEYFRAMES} keyframes (first frame, last frame)")
    if sampling.mode == "ref2v":
        if len(sampling.keyframes) > MAX_REFERENCES:
            raise ValueError(f"at most {MAX_REFERENCES} reference images")
        if not models.ref_unet:
            raise ValueError("ref2v needs the ref2va checkpoint, and none is configured")
        if sampling.ref_image_size not in REF_IMAGE_SIZES:
            raise ValueError(f"ref_image_size must be one of {', '.join(REF_IMAGE_SIZES)}")

    unet = models.ref_unet if sampling.mode == "ref2v" else models.unet
    # ref2v's references load under their own ids, so a graph reads as what it
    # is: `keyframe0` opens a clip, `reference0` is cited by one.
    image_prefix = "reference" if sampling.mode == "ref2v" else "keyframe"

    graph: dict[str, Any] = {
        UNET: {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": unet, "weight_dtype": models.weight_dtype},
        },
        LORA: {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {
                "model": [UNET, 0],
                "lora_name": models.lora,
                "strength": LORA_STRENGTH,
                "low_vram": models.merge_lora,
            },
        },
        SHIFT: {
            # Carried explicitly rather than left to the node's defaults: the
            # shift is the one sampling knob this model has, and a job that
            # moved it should be able to read it back out of its own graph.
            "class_type": "MiniMaxH3SigmaShift",
            "inputs": {
                "model": [LORA, 0],
                "shift_video": sampling.shift_video,
                "shift_audio": sampling.shift_audio,
            },
        },
        CLIP: {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": models.clip,
                # H3's own tokenizer, not Qwen's: the repack adds special
                # tokens the transformer's per-token modality tags depend on.
                "type": "minimax",
                "device": models.clip_device,
            },
        },
        VIDEO_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.video_vae}},
        AUDIO_VAE: {"class_type": "VAELoader", "inputs": {"vae_name": models.audio_vae}},
        COND: _conditioning(sampling),
        GUIDER: {
            # No CFG. The released checkpoints are CFG-distilled, so there is
            # one transformer call per step and no negative branch.
            "class_type": "BasicGuider",
            "inputs": {"model": [SHIFT, 0], "conditioning": [COND, 0]},
        },
        NOISE: {"class_type": "RandomNoise", "inputs": {"noise_seed": sampling.seed}},
        SAMPLER_SELECT: {"class_type": "MiniMaxH3TurboSampler", "inputs": {}},
        SIGMAS: {
            "class_type": "BasicScheduler",
            "inputs": {
                # The shifted model, not the bare one: the sigma schedule is
                # computed from `model_sampling`, which is what the shift node
                # replaced.
                "model": [SHIFT, 0],
                "scheduler": sampling.scheduler,
                "steps": sampling.steps,
                "denoise": 1.0,
            },
        },
        SAMPLER: {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": [NOISE, 0],
                "guider": [GUIDER, 0],
                "sampler": [SAMPLER_SELECT, 0],
                "sigmas": [SIGMAS, 0],
                "latent_image": [COND, 1],
            },
        },
        # One packed latent, two decoders. Both read the same sampler output.
        DECODE_VIDEO: {
            "class_type": "VAEDecode",
            "inputs": {"samples": [SAMPLER, 0], "vae": [VIDEO_VAE, 0]},
        },
        DECODE_AUDIO: {
            "class_type": "VAEDecodeAudio",
            "inputs": {"samples": [SAMPLER, 0], "vae": [AUDIO_VAE, 0]},
        },
        CREATE: {
            "class_type": "CreateVideo",
            "inputs": {
                "images": [DECODE_VIDEO, 0],
                "fps": float(FPS),
                "audio": [DECODE_AUDIO, 0],
            },
        },
        SAVE: {
            "class_type": "SaveVideo",
            "inputs": {
                "video": [CREATE, 0],
                "filename_prefix": filename_prefix,
                # `format` is a dynamic combo: its live value is the bare
                # option key, and the inputs that option unlocks arrive beside
                # it under a dotted path. A nested object is silently dropped
                # -- the option lookup compares it against a string, finds no
                # match, and `format` never reaches the node at all.
                "format": OUTPUT_FORMAT,
                "format.codec": "auto",
            },
        },
    }

    for index, keyframe in enumerate(sampling.keyframes):
        graph[f"{image_prefix}{index}"] = {"class_type": "LoadImage", "inputs": {"image": keyframe}}

    return graph

"""Job validation and one generation run.

The distilled checkpoint is driven by an explicit sigma schedule rather than a
step count, and it is trained to run unguided -- so guidance is off and there is
one transformer call per step instead of two. Overriding either would be a
different model, so neither is exposed as a job parameter.
"""

from __future__ import annotations

import dataclasses
import os
import random
import sys
import threading
import time
from pathlib import Path
from typing import Any

import torch
from PIL import Image

# 8 steps. Imported rather than copied: it belongs to the checkpoint, not to us.
from diffusers.pipelines.ltx2.utils import (
    DEFAULT_NEGATIVE_PROMPT,
    DISTILLED_SIGMA_VALUES,
    STAGE_2_DISTILLED_SIGMA_VALUES,
    TEMPORAL_ROUND_DISTILLED_SIGMA_VALUES,
)

MAX_PROMPT_CHARS = 8000
# The VAE compresses 32x spatially and 8x temporally, so dimensions that are not
# multiples of 32 (and frame counts that are not 8n+1) are silently rounded by
# the pipeline. Rejecting them is clearer than returning a different size.
SPATIAL_MULTIPLE = 32
TEMPORAL_MULTIPLE = 8
# Measured calibration, not a guess. A run that fits still reserves a little past
# the card (0.82 GiB at 512x288x49); a run that does not fit reaches 9.8 GiB
# before its first step finishes and 22.2 GiB at 960x544x121. 2 GiB separates the
# two by an order of magnitude either way.
SPILL_ABORT_GIB = 2.0
SPILL_POLL_SECONDS = 2.0


class JobError(ValueError):
    """A job request that is invalid on its face."""


class VramSpill(RuntimeError):
    """Raised when CUDA memory has been pushed into system RAM.

    WDDM will not raise for us: it satisfies over-capacity allocations out of
    system RAM, so a run that no longer fits becomes a slow run rather than a
    failed one. Aborting is the honest outcome -- a spilled clip took over twelve
    minutes and never finished, against seconds of PCIe if it had fit.
    """

    def __init__(self, spilled_gib: float, step: int) -> None:
        super().__init__(
            f"VRAM spilled {spilled_gib:.2f} GiB into system RAM at step {step}; aborting. "
            f"Lower width/height/numFrames, or check that VAE tiling is enabled."
        )
        self.spilled_gib = spilled_gib
        self.step = step


@dataclasses.dataclass(frozen=True)
class Job:
    prompt: str
    out_path: Path
    # Set for image-to-video. The conditioning frame is encoded to latents before
    # the first denoising step, which is why the VAE has to be on the card from
    # the start rather than only for decode.
    image_path: Path | None = None
    # Lightricks' own prompt enhancer, a Gemma that rewrites a short request into
    # the long audio-visual caption style the model was trained on.
    enhance_prompt: bool = False
    # Two-stage distilled generation: width/height/num_frames describe stage one,
    # and each upsampler doubles what comes out of it.
    spatial_upsample: bool = False
    temporal_upsample: bool = False
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT
    width: int = 960
    height: int = 544
    num_frames: int = 121
    frame_rate: float = 24.0
    seed: int = -1


@dataclasses.dataclass(frozen=True)
class GenerationReport:
    seconds_total: float
    seconds_encode_prompt: float
    seconds_per_step: list[float]
    steps: int
    seed: int
    out_path: str
    out_bytes: int
    peak_vram_allocated_gib: float
    peak_vram_reserved_gib: float
    peak_host_rss_gib: float
    # What actually reached the model. Equal to the request unless the enhancer
    # ran, and the caller has no other way to find out what it produced.
    prompt_used: str = ""
    stages: list[dict[str, Any]] = dataclasses.field(default_factory=list)


def _require_int(body: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise JobError(f"{key} must be an integer")
    if not low <= value <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return value


def parse_job(body: dict[str, Any], out_dir: Path, in_dir: Path) -> Job:
    """Validate a job request and confine its output path to `out_dir`.

    Confinement is enforced here because job requests do not pass through the
    supervisor's parameter resolver -- only start parameters do.
    """
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("prompt is required")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise JobError(f"prompt exceeds {MAX_PROMPT_CHARS} characters")

    negative = body.get("negativePrompt", DEFAULT_NEGATIVE_PROMPT)
    if not isinstance(negative, str) or len(negative) > MAX_PROMPT_CHARS:
        raise JobError(f"negativePrompt must be a string of at most {MAX_PROMPT_CHARS} characters")

    raw_out = body.get("outPath")
    if not isinstance(raw_out, str) or not raw_out.strip():
        raise JobError("outPath is required")
    if "\x00" in raw_out:
        raise JobError("outPath contains a null byte")

    root = out_dir.resolve()
    resolved = (root / raw_out).resolve()
    if resolved == root or root not in resolved.parents:
        raise JobError("outPath resolves outside the arm's output directory")
    if resolved.suffix.lower() != ".mp4":
        raise JobError("outPath must end in .mp4 -- output is a muxed video+audio file")

    width = _require_int(body, "width", 960, 256, 1920)
    height = _require_int(body, "height", 544, 256, 1920)
    if width % SPATIAL_MULTIPLE or height % SPATIAL_MULTIPLE:
        raise JobError(f"width and height must be multiples of {SPATIAL_MULTIPLE}")

    num_frames = _require_int(body, "numFrames", 121, 9, 481)
    if (num_frames - 1) % TEMPORAL_MULTIPLE:
        raise JobError(f"numFrames must be {TEMPORAL_MULTIPLE}n+1, e.g. 121")

    frame_rate = body.get("frameRate", 24.0)
    if isinstance(frame_rate, bool) or not isinstance(frame_rate, (int, float)):
        raise JobError("frameRate must be a number")
    if not 8 <= float(frame_rate) <= 60:
        raise JobError("frameRate must be between 8 and 60")

    seed = _require_int(body, "seed", -1, -1, 2**31 - 1)
    image_path = _resolve_image(body, in_dir)
    enhance = _require_bool(body, "enhancePrompt")
    spatial = _require_bool(body, "spatialUpsample")
    temporal = _require_bool(body, "temporalUpsample")

    return Job(
        prompt=prompt,
        out_path=resolved,
        image_path=image_path,
        enhance_prompt=enhance,
        spatial_upsample=spatial,
        temporal_upsample=temporal,
        negative_prompt=negative,
        width=width,
        height=height,
        num_frames=num_frames,
        frame_rate=float(frame_rate),
        seed=seed,
    )


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def _require_bool(body: dict[str, Any], key: str, default: bool = False) -> bool:
    value = body.get(key, default)
    if not isinstance(value, bool):
        raise JobError(f"{key} must be true or false")
    return value


def _resolve_image(body: dict[str, Any], in_dir: Path) -> Path | None:
    """Confine a job's conditioning image to the arm's input directory.

    Same reasoning as `outPath`: job requests do not pass through the
    supervisor's parameter resolver, so containment is checked here.
    """
    raw = body.get("image")
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise JobError("image must be a non-empty string when given")
    if "\x00" in raw:
        raise JobError("image contains a null byte")

    root = in_dir.resolve()
    resolved = (root / raw).resolve()
    if resolved == root or root not in resolved.parents:
        raise JobError("image resolves outside the arm's input directory")
    if resolved.suffix.lower() not in IMAGE_SUFFIXES:
        raise JobError(f"image must be one of {', '.join(IMAGE_SUFFIXES)}")
    if not resolved.is_file():
        raise JobError("image does not exist")
    return resolved


class SpillWatchdog:
    """Kills the process as soon as CUDA memory lands in system RAM.

    The step callback is not enough on its own: once a run spills, a single step
    takes minutes, so an end-of-step check reacts far too late -- measured, spill
    reached 9.8 GiB before step one had finished. This samples every couple of
    seconds instead.

    It exits the process rather than raising because there is no way to interrupt
    a CUDA kernel already queued from another thread, and a spilled process has
    nothing worth recovering: the supervisor restarts the arm.
    """

    def __init__(self, limit_gib: float = SPILL_ABORT_GIB) -> None:
        self._limit = limit_gib
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        from .loading import vram_spill_gib

        while not self._stop.wait(SPILL_POLL_SECONDS):
            spilled = vram_spill_gib()
            if spilled > self._limit:
                print(
                    f"[ltx25] ABORT: {spilled:.2f} GiB of CUDA memory is in system RAM. "
                    f"The driver will not raise for this, it will only run slowly. "
                    f"Reduce width/height/numFrames.",
                    file=sys.stderr,
                    flush=True,
                )
                os._exit(3)

    def __enter__(self) -> SpillWatchdog:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()


def _denoise_pipeline(pipe: Any, job: Job) -> tuple[Any, dict[str, Any]]:
    """The entry point for this job, over the weights already loaded.

    `LTX2Pipeline` has no image input; conditioning on a first frame is a
    different pipeline class over the same components. It is built from
    `pipe.components` rather than with `from_pipe`, which re-applies a dtype to
    everything it takes and leaves the connectors in float32 against bf16
    activations -- surfacing four frames down as "mat1 and mat2 must have the
    same dtype", nowhere near the cause.

    Sharing components means no second copy of any weight, and the transformer
    keeps the group-offload hooks already attached to it.
    """
    if job.image_path is None:
        return pipe, {}

    import inspect

    from diffusers import LTX2ImageToVideoPipeline
    from PIL import Image

    wanted = set(inspect.signature(LTX2ImageToVideoPipeline.__init__).parameters) - {"self"}
    i2v = LTX2ImageToVideoPipeline(**{k: v for k, v in pipe.components.items() if k in wanted})
    i2v.set_progress_bar_config(disable=False)
    return i2v, {"image": Image.open(job.image_path).convert("RGB")}


def _release_connectors_after_use(pipe: Any) -> Any:
    """Send the connectors back to the host the moment they are done.

    They run once per *round*, before each denoising loop, and then hold 5.91
    GiB of the card for the whole of it. `denoise` re-places them at the top of
    every round precisely because this hook takes them away after each one. Text-to-video can afford that; image
    conditioning cannot. Its per-token AdaLN modulation costs about 3 GiB more,
    which takes peak VRAM to 15.6 GiB of 16 -- and measured, a job following
    another in the same process reached 15.88 GiB and slowed from 8.5 s per step
    to 19.0 s. Nothing raised: `memory_reserved()` stayed under the card's
    capacity, so the spill watchdog saw nothing while the driver was already
    evicting behind it.
    """
    from .stages import CPU

    def hook(module: Any, _inputs: Any, _output: Any) -> None:
        module.to(CPU)

    return pipe.connectors.register_forward_hook(hook)


def generate(pipe: Any, job: Job, model_dir: Path, progress: Any | None = None) -> GenerationReport:
    """Encode, denoise and decode as three stages, releasing the card between them.

    Peak VRAM is then the largest single stage rather than the sum of all three,
    which is the difference between fitting on a 16 GiB card and spilling into
    system RAM.
    """
    from diffusers.utils import encode_video

    from .loading import host_rss_gib
    from .progress import JobProgress
    from .stages import (
        CUDA,
        DECODE_TIMESTEP,
        StageReport,
        encode,
        enter_decode,
        enter_denoise,
        place,
        release,
        stage,
    )

    # A caller with no interest in progress -- the benchmark harness -- gets a
    # record that is written and never read, rather than a branch at every step.
    progress = progress if progress is not None else JobProgress()

    seed = job.seed if job.seed >= 0 else random.randrange(2**31 - 1)
    generator = torch.Generator("cuda").manual_seed(seed)

    # Which denoising round the step callback is currently reporting. There are
    # up to three -- the base pass and one tail per upsampler -- and they share
    # one callback, so it has to be told which one it is in.
    round_state = {"key": "denoise", "total": len(DISTILLED_SIGMA_VALUES), "index": 0, "last": 0.0}

    def latent_size(current: torch.Tensor) -> str:
        """The size a round actually runs at, read off the tensor.

        Not `job.width`/`job.height`: those describe stage one, and any round
        after the spatial upsampler runs at twice them. The latent grid is
        [B, C, frames, H, W] with space compressed by 32, so this stays right
        whichever rounds happened to run before it.
        """
        return f"{current.shape[4] * SPATIAL_MULTIPLE}×{current.shape[3] * SPATIAL_MULTIPLE}"

    def begin_round(key: str, label: str, detail: str, total: int) -> None:
        round_state.update(key=key, total=total, index=0, last=time.perf_counter())
        progress.start(key, label, detail)
        progress.meter(key, label, total, detail)
        progress.start(f"{key}-1", "step 1", parent=key)

    def end_round() -> None:
        progress.finish_step(round_state["key"])

    marks: list[float] = []
    peak_rss = host_rss_gib()
    reports: list[StageReport] = []

    def on_step_end(_pipe: Any, step: int, _timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        nonlocal peak_rss
        now = time.perf_counter()
        marks.append(now)
        peak_rss = max(peak_rss, host_rss_gib())
        last = now - (marks[-2] if len(marks) > 1 else denoise_started)
        from .loading import vram_spill_gib

        key = str(round_state["key"])
        index = int(round_state["index"]) + 1
        round_state["index"] = index
        progress.finish_step(f"{key}-{index}", seconds=now - float(round_state["last"]))
        round_state["last"] = now
        progress.advance(key, index)
        # The end of one step is the start of the next, which is the only signal
        # the pipeline offers -- there is no on_step_begin.
        if index < int(round_state["total"]):
            progress.start(f"{key}-{index + 1}", f"step {index + 1}", parent=key)
        progress.sample_vram()

        print(
            f"[ltx25] step {step + 1}/{round_state['total']} "
            f"{last:.1f}s vram={torch.cuda.memory_reserved() / 1024**3:.2f}GiB "
            f"spill={vram_spill_gib():.2f}GiB rss={peak_rss:.1f}GiB",
            flush=True,
        )
        return kwargs

    started = time.perf_counter()
    # Doubled by the temporal round, which adds frames without adding runtime.
    output_frame_rate = job.frame_rate

    with SpillWatchdog():
        prompt = job.prompt
        if job.enhance_prompt:
            # Lightricks' own enhancer, with the system prompts diffusers ships
            # for LTX-2.5. Run before the encode stage rather than inside
            # `__call__`: the arm supplies `prompt_embeds`, so the pipeline's own
            # `enable_prompt_enhancement` would never fire.
            from .refine import enhanced_prompt

            looked = " · looked at the reference image" if job.image_path else ""
            with progress.step("enhance", "Prompt enhancer rewrote the prompt") as reported:
                with stage("enhance", reports):
                    prompt = enhanced_prompt(
                        pipe,
                        model_dir,
                        job.prompt,
                        image=Image.open(job.image_path).convert("RGB") if job.image_path else None,
                        seed=seed,
                    )
                reported.detail(f"{len(prompt)} chars{looked}")
                reported.note(prompt, replaces=job.prompt)
            print(f"[ltx25] enhanced prompt: {prompt[:160]}...", flush=True)

        # --- stage 1: text -------------------------------------------------
        from .stages import MAX_PROMPT_TOKENS

        with progress.step("encode", "Encode prompt", f"{MAX_PROMPT_TOKENS} tokens"):
            embeds = encode(pipe, prompt, job.negative_prompt, reports)

        # --- stage 2: denoise ----------------------------------------------
        denoise_pipe, image_kwargs = _denoise_pipeline(pipe, job)
        connector_hook = _release_connectors_after_use(pipe) if job.image_path else None
        # try/finally, because the hook outlives a failed job otherwise: it is
        # attached to a module that lives as long as the arm, so one exception
        # mid-round would leave every later job -- including text-to-video ones
        # that never asked for it -- bouncing 5.91 GiB off the card each round.
        try:
            # Image conditioning encodes its frame to latents before the first step,
            # so the VAE has to be up front rather than only for decode. Measured, it
            # costs nothing: text-to-video with the VAE resident runs at the same
            # 4.24 s per step.
            enter_denoise(pipe, extra=("vae",) if job.image_path else ())
            denoise_started = time.perf_counter()

            def denoise(pipeline: Any, **overrides: Any) -> tuple[torch.Tensor, torch.Tensor]:
                # Brought back every round, not once before the loop. An image job
                # installs a hook that returns the connectors to the host the moment
                # their single forward is done, so every round after the first would
                # otherwise find 5.91 GiB of weights on the CPU and fail with
                # "mat1 is on cuda:0, other tensors on cpu" -- which is exactly what
                # image-to-video plus an upsampler did. A no-op when they are already
                # resident, so text-to-video pays nothing for it.
                place(pipe, ("connectors",), CUDA)

                call = dict(
                    frame_rate=job.frame_rate,
                    sigmas=DISTILLED_SIGMA_VALUES,
                    # The distilled model is unguided, and every one of these has to
                    # be said. The pipeline's defaults are the SFT values, so any left
                    # out silently re-enables a guidance the distillation removed:
                    # `modality_scale` defaults to 3.0, and `do_modality_isolation_guidance`
                    # is `modality_scale > 1.0`, which runs a second full transformer
                    # forward per step. Measured, leaving these two out cost 7.93 s per
                    # step against 4.24 s -- and, per the model card, degrades the
                    # result as well, which is the more expensive half.
                    guidance_scale=1.0,
                    audio_guidance_scale=1.0,
                    stg_scale=0.0,
                    audio_stg_scale=0.0,
                    modality_scale=1.0,
                    audio_modality_scale=1.0,
                    decode_timestep=DECODE_TIMESTEP,
                    generator=generator,
                    output_type="latent",
                    return_dict=False,
                    callback_on_step_end=on_step_end,
                    **embeds,
                )
                call.update(overrides)
                video_latents, sound_latents = pipeline(**call)
                return video_latents.detach(), sound_latents.detach()

            with stage("denoise", reports):
                begin_round(
                    "denoise",
                    "Denoise",
                    f"{len(DISTILLED_SIGMA_VALUES)} steps · {job.width}×{job.height}"
                    f" · {type(denoise_pipe).__name__}",
                    len(DISTILLED_SIGMA_VALUES),
                )
                latents, audio_latents = denoise(
                    denoise_pipe,
                    **image_kwargs,
                    width=job.width,
                    height=job.height,
                    num_frames=job.num_frames,
                )
                end_round()

                if job.spatial_upsample:
                    # The documented two-stage recipe: half-resolution pass, x2 latent
                    # upsample, then a three-sigma tail at the new size. The tail is
                    # what makes this different from an upscale -- the model redraws
                    # detail rather than interpolating it.
                    from .refine import upsample_spatial

                    with progress.step(
                        "spatial", "Spatial ×2", f"{job.width * 2}×{job.height * 2}"
                    ):
                        latents = upsample_spatial(pipe, model_dir, latents)
                    begin_round(
                        "spatial-refine",
                        "Spatial refine",
                        f"{len(STAGE_2_DISTILLED_SIGMA_VALUES)} steps · {latent_size(latents)}",
                        len(STAGE_2_DISTILLED_SIGMA_VALUES),
                    )
                    latents, audio_latents = denoise(
                        pipe,
                        num_frames=job.num_frames,
                        sigmas=STAGE_2_DISTILLED_SIGMA_VALUES,
                        latents=latents,
                        audio_latents=audio_latents,
                        noise_scale=STAGE_2_DISTILLED_SIGMA_VALUES[0],
                    )
                    end_round()

                if job.temporal_upsample:
                    from .refine import upsample_temporal

                    with progress.step("temporal", "Temporal ×2") as reported:
                        latents = upsample_temporal(pipe, model_dir, latents)
                    # The latent tensor is [B, C, frames, H, W] with time compressed
                    # by 8, so the new frame count is read back from it rather than
                    # assumed -- the upsampler decides how many frames it produced.
                    frames = (latents.shape[2] - 1) * TEMPORAL_MULTIPLE + 1
                    output_frame_rate = job.frame_rate * frames / job.num_frames
                    reported.detail(
                        f"{frames} frames @{output_frame_rate:.0f} fps, same duration"
                    )
                    begin_round(
                        "temporal-refine",
                        "Temporal refine",
                        f"{len(TEMPORAL_ROUND_DISTILLED_SIGMA_VALUES)} steps · "
                        f"{latent_size(latents)} · {frames} frames",
                        len(TEMPORAL_ROUND_DISTILLED_SIGMA_VALUES),
                    )
                    latents, audio_latents = denoise(
                        pipe,
                        num_frames=frames,
                        frame_rate=output_frame_rate,
                        sigmas=TEMPORAL_ROUND_DISTILLED_SIGMA_VALUES,
                        latents=latents,
                        audio_latents=audio_latents,
                        noise_scale=TEMPORAL_ROUND_DISTILLED_SIGMA_VALUES[0],
                    )
                    end_round()

        finally:
            if connector_hook is not None:
                connector_hook.remove()
        del embeds
        # Not set to None. Group offloading already returns each block to the
        # host as it finishes, so the transformer holds no block weights here,
        # and destroying it left the arm able to serve exactly one job -- the
        # second call reached `self.transformer.config` on a None.
        release()

        # --- stage 3: decode ------------------------------------------------
        with progress.step("decode", "Decoders onto the card"):
            enter_decode(pipe)
            with stage("decode", reports):
                video, audio, sample_rate = _decode(pipe, latents, audio_latents)
        del latents, audio_latents

    denoised = time.perf_counter()
    frame_count = int(video[0].shape[0])
    with progress.step(
        "mux",
        "Mux video and audio",
        f"{frame_count} frames · {frame_count / max(output_frame_rate, 1e-6):.2f} s"
        f" @{output_frame_rate:.0f} fps",
    ):
        job.out_path.parent.mkdir(parents=True, exist_ok=True)
        encode_video(
            video[0],
            fps=int(round(output_frame_rate)),
            output_path=str(job.out_path),
            audio=audio[0].float().cpu() if audio is not None else None,
            audio_sample_rate=sample_rate,
        )

    per_step = [b - a for a, b in zip(marks, marks[1:])]
    prologue = reports[0].seconds if reports else (denoised - started)

    return GenerationReport(
        seconds_total=time.perf_counter() - started,
        seconds_encode_prompt=prologue,
        seconds_per_step=per_step,
        steps=len(DISTILLED_SIGMA_VALUES),
        seed=seed,
        prompt_used=prompt,
        out_path=str(job.out_path),
        out_bytes=job.out_path.stat().st_size if job.out_path.exists() else 0,
        peak_vram_allocated_gib=max((r.peak_vram_gib for r in reports), default=0.0),
        peak_vram_reserved_gib=max((r.peak_vram_gib for r in reports), default=0.0),
        peak_host_rss_gib=max(peak_rss, host_rss_gib()),
        stages=[dataclasses.asdict(r) for r in reports],
    )


@torch.no_grad()
def _decode(pipe: Any, latents: torch.Tensor, audio_latents: torch.Tensor) -> tuple[Any, Any, int | None]:
    """Stage 3, replicating the pipeline's own decode on already-denormalised latents.

    `output_type="latent"` returns latents that have been denormalised but not
    passed through the decode-noise blend. At `decode_timestep=0.0` -- the
    pipeline's default and what stage 2 requests -- that blend is the identity,
    so feeding these straight to the VAE matches the pipeline exactly.
    """
    from .stages import DECODE_TIMESTEP

    # The pipeline runs its own decode under no_grad; calling the VAE directly
    # does not inherit that, and the frames come back attached to a graph that
    # `encode_video` cannot convert to numpy.
    timestep = None
    if getattr(pipe.vae.config, "timestep_conditioning", False):
        timestep = torch.tensor([DECODE_TIMESTEP], device=latents.device, dtype=latents.dtype)

    video = pipe.vae.decode(latents.to(pipe.vae.dtype), timestep, return_dict=False)[0]
    video = pipe.video_processor.postprocess_video(video, output_type="np")

    audio = None
    sample_rate = None
    if getattr(pipe, "audio_vae", None) is not None and getattr(pipe, "vocoder", None) is not None:
        mel = pipe.audio_vae.decode(audio_latents.to(pipe.audio_vae.dtype), return_dict=False)[0]
        audio = pipe.vocoder(mel)
        sample_rate = pipe.vocoder.config.output_sampling_rate

    return video, audio, sample_rate

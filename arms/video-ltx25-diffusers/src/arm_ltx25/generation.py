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

# 8 steps. Imported rather than copied: it belongs to the checkpoint, not to us.
from diffusers.pipelines.ltx2.utils import DEFAULT_NEGATIVE_PROMPT, DISTILLED_SIGMA_VALUES

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
    stages: list[dict[str, Any]] = dataclasses.field(default_factory=list)


def _require_int(body: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    value = body.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise JobError(f"{key} must be an integer")
    if not low <= value <= high:
        raise JobError(f"{key} must be between {low} and {high}")
    return value


def parse_job(body: dict[str, Any], out_dir: Path) -> Job:
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

    return Job(
        prompt=prompt,
        out_path=resolved,
        negative_prompt=negative,
        width=width,
        height=height,
        num_frames=num_frames,
        frame_rate=float(frame_rate),
        seed=seed,
    )


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


def generate(pipe: Any, job: Job) -> GenerationReport:
    """Encode, denoise and decode as three stages, releasing the card between them.

    Peak VRAM is then the largest single stage rather than the sum of all three,
    which is the difference between fitting on a 16 GiB card and spilling into
    system RAM.
    """
    from diffusers.utils import encode_video

    from .loading import host_rss_gib
    from .stages import DECODE_TIMESTEP, StageReport, encode, enter_decode, enter_denoise, release, stage

    seed = job.seed if job.seed >= 0 else random.randrange(2**31 - 1)
    generator = torch.Generator("cuda").manual_seed(seed)

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

        print(
            f"[ltx25] step {step + 1}/{len(DISTILLED_SIGMA_VALUES)} "
            f"{last:.1f}s vram={torch.cuda.memory_reserved() / 1024**3:.2f}GiB "
            f"spill={vram_spill_gib():.2f}GiB rss={peak_rss:.1f}GiB",
            flush=True,
        )
        return kwargs

    started = time.perf_counter()

    with SpillWatchdog():
        # --- stage 1: text -------------------------------------------------
        embeds = encode(pipe, job.prompt, job.negative_prompt, reports)

        # --- stage 2: denoise ----------------------------------------------
        enter_denoise(pipe)
        denoise_started = time.perf_counter()
        with stage("denoise", reports):
            latents, audio_latents = pipe(
                width=job.width,
                height=job.height,
                num_frames=job.num_frames,
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
            latents = latents.detach()
            audio_latents = audio_latents.detach()

        del embeds
        # Not set to None. Group offloading already returns each block to the
        # host as it finishes, so the transformer holds no block weights here,
        # and destroying it left the arm able to serve exactly one job -- the
        # second call reached `self.transformer.config` on a None.
        release()

        # --- stage 3: decode ------------------------------------------------
        enter_decode(pipe)
        with stage("decode", reports):
            video, audio, sample_rate = _decode(pipe, latents, audio_latents)
        del latents, audio_latents

    denoised = time.perf_counter()
    job.out_path.parent.mkdir(parents=True, exist_ok=True)
    encode_video(
        video[0],
        fps=int(round(job.frame_rate)),
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

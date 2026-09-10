"""Prompt enhancement and the two upsampling rounds, all from Lightricks' weights.

Each of these is a first-party component of `Lightricks/LTX-2.5-Diffusers` rather
than a substitute: the enhancer is the repo's own `prompt_enhancer/` with the
system prompts diffusers ships for LTX-2.5, and the upsamplers are its
`latent_upsampler/` and `temporal_latent_upsampler/`.

All three are loaded on demand and freed again. The enhancer is 9.51 GiB, which
is more than the card has spare once the pipeline is resident, and it runs once
per job before anything else needs the GPU. The upsamplers are small -- 0.93 and
0.24 GiB -- but there is no reason to hold them for jobs that do not ask.
"""

from __future__ import annotations

import gc
from pathlib import Path
from typing import Any

import torch

CUDA = torch.device("cuda")
CPU = torch.device("cpu")


def _release() -> None:
    gc.collect()
    torch.cuda.empty_cache()


def enhanced_prompt(
    pipe: Any,
    model_dir: Path,
    prompt: str,
    image: Any | None = None,
    seed: int = 10,
) -> str:
    """Rewrite a short request into the caption style the model was trained on.

    The model card is explicit that LTX-2.5 "was trained on long, single-paragraph
    audio-visual captions and degrades on short prompts", so this is closer to a
    format conversion than an embellishment.

    Loaded here rather than by `from_pretrained`, because the pipeline would hold
    all 9.51 GiB of it in host RAM for every job including the ones that never ask.
    """
    from diffusers.pipelines.ltx2.utils import (
        GEMMA4_PROMPT_ENHANCEMENT_CONFIG,
        LTX2_5_I2V_DEFAULT_SYSTEM_PROMPT,
        LTX2_5_T2V_DEFAULT_SYSTEM_PROMPT,
    )
    from transformers import Gemma4ForConditionalGeneration

    source = model_dir / "prompt_enhancer"
    if not source.is_dir():
        raise FileNotFoundError(
            f"prompt enhancement was requested but {source} is absent; "
            f'fetch it with hf download Lightricks/LTX-2.5-Diffusers --include "prompt_enhancer/*"'
        )

    from .stages import clear_card

    # The enhancer wants the card to itself; see `clear_card`.
    clear_card(pipe)
    enhancer = Gemma4ForConditionalGeneration.from_pretrained(source, dtype=torch.bfloat16)
    enhancer.to(CUDA)
    pipe.prompt_enhancer = enhancer
    try:
        system = LTX2_5_I2V_DEFAULT_SYSTEM_PROMPT if image is not None else LTX2_5_T2V_DEFAULT_SYSTEM_PROMPT
        with torch.no_grad():
            written = pipe.enhance_prompt(
                prompt=prompt,
                system_prompt=system,
                seed=seed,
                max_new_tokens=GEMMA4_PROMPT_ENHANCEMENT_CONFIG.max_new_tokens,
                generation_kwargs=dict(GEMMA4_PROMPT_ENHANCEMENT_CONFIG.generation_kwargs),
                device=CUDA,
                image=image,
            )
    finally:
        pipe.prompt_enhancer = None
        enhancer.to(CPU)
        del enhancer
        _release()

    return written[0] if isinstance(written, list) else written


def _upsampler(model_dir: Path, subfolder: str) -> Any:
    from diffusers.pipelines.ltx2.latent_upsampler import LTX2LatentUpsamplerModel

    source = model_dir / subfolder
    if not source.is_dir():
        raise FileNotFoundError(
            f"upsampling was requested but {source} is absent; "
            f'fetch it with hf download Lightricks/LTX-2.5-Diffusers --include "{subfolder}/*"'
        )
    return LTX2LatentUpsamplerModel.from_pretrained(source, dtype=torch.bfloat16).to(CUDA)


def upsample_spatial(pipe: Any, model_dir: Path, latents: torch.Tensor) -> torch.Tensor:
    """Double each spatial edge in latent space.

    This is the first half of the two-stage distilled recipe; the caller still has
    to run the three-sigma tail at the new size, which is what turns an upscale
    into detail the model actually drew.
    """
    from diffusers import LTX2LatentUpsamplePipeline

    model = _upsampler(model_dir, "latent_upsampler")
    try:
        upsample = LTX2LatentUpsamplePipeline(vae=pipe.vae, latent_upsampler=model)
        with torch.no_grad():
            out = upsample(latents=latents, output_type="latent", return_dict=False)[0]
        return out.detach()
    finally:
        model.to(CPU)
        del model
        _release()


def upsample_temporal(pipe: Any, model_dir: Path, latents: torch.Tensor) -> torch.Tensor:
    """Double the frame count at the same duration, in latent space.

    Same shape of operation as the spatial round, and deliberately not
    `LTX2DFRTemporalRefinePipeline`: that one belongs to the distilled-frame-rate
    chain and requires `keyframes_latents` and `keyframe_positions` from a
    previous DFR pass, which a plain `LTX2Pipeline` run does not produce.

    Doubling frames at a fixed duration means doubling the frame rate rather than
    the runtime. That is the reading the audio forces: audio latents are sized
    from the clip's seconds, so a round that changed the duration would leave
    them the wrong length, while one that changes only the frame rate leaves them
    exactly right.
    """
    from diffusers import LTX2LatentUpsamplePipeline

    model = _upsampler(model_dir, "temporal_latent_upsampler")
    try:
        upsample = LTX2LatentUpsamplePipeline(vae=pipe.vae, latent_upsampler=model)
        with torch.no_grad():
            out = upsample(latents=latents, output_type="latent", return_dict=False)[0]
        return out.detach()
    finally:
        model.to(CPU)
        del model
        _release()

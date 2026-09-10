"""Three-stage execution with an explicit VRAM release between stages.

`LTX2Pipeline.__call__` runs encode, denoise and decode in one breath, holding
its components hooked throughout. On a 16 GiB card that does not work: measured,
the text encoder and transformer together pushed 22.22 GiB into system RAM and a
clip never finished.

So the stages are driven separately here:

    1. encode   text encoder              -> prompt embeddings, then freed
    2. denoise  transformer only          -> latents, then freed
    3. decode   vae + audio vae + vocoder -> video and audio

Each stage returns plain tensors and drops every module it used before the next
one allocates, so peak VRAM is the largest single stage rather than their sum.
"""

from __future__ import annotations

import dataclasses
import gc
import time
from typing import Any

import torch

from .loading import GIB, vram_snapshot, vram_spill_gib

# The decode path in `LTX2Pipeline.__call__` mixes noise into the latents before
# denormalising them, but at the pipeline's own default of decode_timestep=0.0
# that blend is the identity. Stage 3 reuses the already-denormalised latents
# that `output_type="latent"` returns, which is only correct while this holds.
DECODE_TIMESTEP = 0.0

# Prompt tokens to encode. The pipeline defaults to 1024; that does not fit here.
# Measured on this card, with the fp8 encoder resident at 12.60 GiB and 2.11 GiB
# free:
#
#     tokens   peak      activations
#        128   13.41       0.81 GiB
#        512   13.96       1.36 GiB
#       1024   14.95       2.35 GiB   <- 0.24 GiB more than is free
#
# So 1024 spills and 512 does not, with 0.75 GiB to spare. 512 tokens is roughly
# two thousand characters of prompt, well past what the distilled model is
# trained to use.
MAX_PROMPT_TOKENS = 512


@dataclasses.dataclass
class StageReport:
    name: str
    seconds: float
    peak_vram_gib: float
    vram_after_release_gib: float
    spill_gib: float

    def line(self) -> str:
        return (
            f"[ltx25] stage {self.name}: {self.seconds:.1f}s "
            f"peak_vram={self.peak_vram_gib:.2f}GiB "
            f"after_release={self.vram_after_release_gib:.2f}GiB "
            f"spill={self.spill_gib:.2f}GiB"
        )


def release() -> float:
    """Drop cached blocks and report what the card is left holding."""
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    return torch.cuda.memory_reserved() / GIB


class stage:
    """Times one stage, records its peak, and releases the card on the way out."""

    def __init__(self, name: str, reports: list[StageReport]) -> None:
        self.name = name
        self.reports = reports

    def __enter__(self) -> stage:
        torch.cuda.reset_peak_memory_stats()
        self.started = time.perf_counter()
        return self

    def __exit__(self, *_: object) -> None:
        peak = torch.cuda.max_memory_reserved() / GIB
        spill = vram_spill_gib()
        after = release()
        report = StageReport(
            name=self.name,
            seconds=time.perf_counter() - self.started,
            peak_vram_gib=peak,
            vram_after_release_gib=after,
            spill_gib=spill,
        )
        self.reports.append(report)
        print(report.line(), flush=True)


CUDA = torch.device("cuda")
CPU = torch.device("cpu")

# Moved by hand rather than by diffusers' hooks. Group offloading splits a model
# into blocks and streams them; these components have no block list it recognises,
# so it onloads each one whole -- which is fine as long as only one is on the card
# at a time, and is exactly what the stage boundaries guarantee.
# Parking a component on the CPU buys VRAM with host RAM, and on this machine
# host RAM is the scarcer of the two. Measured against a standalone script that
# keeps every small component resident on the card instead: 8.14 s per denoising
# step against 4.24 s, because the parked copies push host RAM to 57.6 of 59.2
# GiB and the OS answers by evicting the transformer's pages, which then have to
# be read back from NVMe on every step. The stage boundaries are still what keeps
# peak VRAM at 14.79 GiB with no spill, so this is a real trade rather than a
# mistake -- but the cheaper version is to move `connectors` off the card right
# after its single call, which happens once before the denoising loop, not per
# step. Not done yet.
STAGE_MODULES = {
    "encode": ("text_encoder",),
    # `connectors` is deliberately absent: it is placed on the card once at load
    # and stays there. It runs exactly once per job -- before the denoising loop,
    # not inside it -- so swapping it costs two 5.91 GiB transfers to save VRAM
    # during a stage that never needed the space, and parks 5.91 GiB in host RAM
    # in between. Host RAM is the scarce resource here, not VRAM.
    "denoise": ("duration_head",),
    # `diffusion_decoder` is deliberately absent. `_decode` calls `pipe.vae.decode`
    # and nothing else, and the diffusion decoder could not be used here anyway:
    # it resolves a NATTEN kernel through `get_kernel("shi-labs/natten")`, and that
    # repo is not reachable. Carrying it cost 0.78 GiB of host RAM per stage swap
    # for a component that never ran.
    "decode": ("vae", "audio_vae", "vocoder"),
}


def place(pipe: Any, names: tuple[str, ...], device: torch.device) -> None:
    """Move whole components between host and card, skipping hooked ones.

    A module carrying accelerate's `_hf_hook` manages its own placement: its
    parameters sit on `meta` and the hook materialises each submodule on the card
    immediately before that submodule's forward. Calling `.to()` on it either
    fails outright or silently defeats the hook, and for the bf16 text encoder
    that means trying to make 22.28 GiB resident on a 16 GiB card -- measured,
    5.21 GiB of spill before the watchdog stopped the run.
    """
    for name in names:
        module = getattr(pipe, name, None)
        if module is None or not hasattr(module, "to"):
            continue
        if getattr(module, "_hf_hook", None) is not None:
            continue
        module.to(device)


def on_card(pipe: Any) -> str:
    """Which components are actually sitting on the GPU, and how big each is.

    Printed at every stage boundary because the interesting failures here are all
    of the form "something is resident that should not be" -- and the totals never
    said which something.
    """
    parts = []
    for name in ("text_encoder", "connectors", "transformer", "vae", "audio_vae", "vocoder", "duration_head"):
        module = getattr(pipe, name, None)
        if module is None or not hasattr(module, "parameters"):
            continue
        # Counted as parameters rather than bytes: a torchao tensor reports the
        # outer dtype, so summing `element_size()` says 22.28 GiB for an encoder
        # that occupies 12.60. Use `vram_reserved` for the byte figure.
        resident = sum(p.numel() for p in module.parameters() if p.device.type == "cuda")
        if resident:
            parts.append(f"{name}={resident / 1e9:.2f}B params")
    return " ".join(parts) or "(nothing)"


def encode(pipe: Any, prompt: str, negative_prompt: str, reports: list[StageReport]) -> dict[str, Any]:
    """Stage 1. Returns prompt embeddings and frees the text encoder."""
    place(pipe, STAGE_MODULES["encode"], CUDA)
    snapshot("before encode")
    print(f"[ltx25] on card: {on_card(pipe)}", flush=True)
    with stage("encode", reports):
        embeds, mask = _gemma_embeds(pipe, prompt)
        result = {
            "prompt_embeds": embeds,
            "prompt_attention_mask": mask,
            "negative_prompt_embeds": None,
            "negative_prompt_attention_mask": None,
        }

    # Dropped rather than moved to CPU: this is 22.28 GiB at bf16 and the
    # transformer is about to want the host RAM it occupies. Nothing in
    # `__call__` reaches for it once `prompt_embeds` is supplied -- the remaining
    # references are the image-conditioning and prompt-enhancer paths, neither of
    # which this arm uses.
    #
    # `connectors` stays. It looks like part of text encoding but it is called
    # from inside `__call__`, after the embeddings are in hand, so dropping it
    # would break the denoise stage. It is 5.91 GiB and coexists comfortably.
    # Only dropped when it is holding host RAM the transformer needs. An encoder
    # that manages its own placement is already paged from disk and costs nothing
    # to keep -- and dropping it would leave the arm able to serve exactly one
    # job, which is how this was found: the second generation called into None.
    if getattr(pipe.text_encoder, "_hf_hook", None) is None:
        _drop(pipe, "text_encoder")
    release()
    return result


def _gemma_embeds(pipe: Any, prompt: str) -> tuple[torch.Tensor, torch.Tensor]:
    """`_get_gemma_prompt_embeds`, with the hidden-state stack built on the CPU.

    The pipeline's own version does this on whatever device the encoder is on:

        stacked = torch.stack(outputs.hidden_states, dim=-1)
        embeds  = stacked.flatten(2, 3).to(dtype=dtype)

    Three full copies of a 49-layer hidden-state stack. Measured, that turned a
    1.36 GiB forward pass into 5.46 GiB of peak activations -- against 2.11 GiB
    free once the encoder itself is resident. Moving the hidden states off the
    card before stacking keeps the whole stage inside the card, and costs one
    PCIe round trip of a few hundred MB.
    """
    tokenizer = pipe.tokenizer
    tokenizer.padding_side = "left"
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    inputs = tokenizer(
        [prompt.strip()],
        padding="max_length",
        max_length=MAX_PROMPT_TOKENS,
        truncation=True,
        add_special_tokens=True,
        return_tensors="pt",
    )
    input_ids = inputs.input_ids.to(CUDA)
    attention_mask = inputs.attention_mask.to(CUDA)

    with torch.no_grad():
        outputs = pipe.text_encoder(
            input_ids=input_ids, attention_mask=attention_mask, output_hidden_states=True
        )
        # Off the card one layer at a time, so the stack never exists on the GPU.
        hidden = [h.to(CPU, non_blocking=False) for h in outputs.hidden_states]
    del outputs
    release()

    stacked = torch.stack(hidden, dim=-1)
    del hidden
    embeds = stacked.flatten(2, 3).to(dtype=torch.bfloat16)
    del stacked
    return embeds.to(CUDA), attention_mask.view(1, -1)


def clear_card(pipe: Any) -> None:
    """Send every placed component back to the host.

    Used before loading something that needs the card to itself. The enhancer is
    9.51 GiB and the pipeline holds 7.85 GiB between stages, so loading one on top
    of the other reached 17.17 GiB on a 16 GiB card -- under the watchdog's 2 GiB
    abort threshold, so it was a silent 1.17 GiB spill rather than a failure.

    Nothing is stranded by this: each stage places what it needs on the way in.
    """
    for name in ("text_encoder", "connectors", "duration_head", "vae", "audio_vae", "vocoder"):
        module = getattr(pipe, name, None)
        if module is None or not hasattr(module, "to"):
            continue
        if getattr(module, "_hf_hook", None) is not None:
            continue
        module.to(CPU)
    release()


def enter_denoise(pipe: Any, extra: tuple[str, ...] = ()) -> None:
    """Put the small per-step helpers on the card; the transformer streams itself.

    `extra` names components a particular job needs resident for the whole stage
    -- image conditioning needs the VAE, which the plan otherwise brings up only
    for decode.
    """
    # `connectors` is placed every time rather than once at load, because an
    # image job releases it mid-call (see `_release_connectors_after_use`) and
    # the next job has to find it back on the card.
    place(pipe, STAGE_MODULES["denoise"] + ("connectors",) + extra, CUDA)
    snapshot("before denoise")
    print(f"[ltx25] on card: {on_card(pipe)}", flush=True)


def enter_decode(pipe: Any) -> None:
    """Swap the denoise helpers off and the decoders on."""
    place(pipe, STAGE_MODULES["denoise"], CPU)
    release()
    place(pipe, STAGE_MODULES["decode"], CUDA)
    snapshot("before decode")
    print(f"[ltx25] on card: {on_card(pipe)}", flush=True)


def _drop(pipe: Any, name: str) -> None:
    module = getattr(pipe, name, None)
    if module is None:
        return
    setattr(pipe, name, None)
    del module


def snapshot(label: str) -> None:
    s = vram_snapshot()
    print(
        f"[ltx25] {label}: vram_reserved={s['reserved_gib']:.2f}GiB "
        f"free={s['free_gib']:.2f}GiB spill={s['spill_gib']:.2f}GiB",
        flush=True,
    )

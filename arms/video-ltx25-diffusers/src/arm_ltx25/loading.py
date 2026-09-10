"""Pipeline construction: precision and offload policy live here and nowhere else.

The numbers behind every default are in `docs/stack-selection.md`. In short, on a
16 GiB card the distilled transformer is 2.8x too large at bf16 and 1.4x too
large at fp8, so weights cross PCIe on every denoising step and the only lever
that matters is how well that transfer is hidden.
"""

from __future__ import annotations

import dataclasses
import gc
import time
from pathlib import Path
from typing import Any

import torch

PRECISIONS = ("bf16", "fp8", "int8")
OFFLOADS = ("group-disk", "group-stream", "group", "model", "sequential", "none")

# Only these two are worth quantizing. Every other component is under 1.5 GiB,
# so quantizing them saves nothing measurable and risks decode artefacts.
QUANTIZED_COMPONENTS = ("transformer", "text_encoder")

GIB = 1024**3


@dataclasses.dataclass(frozen=True)
class LoadConfig:
    model_dir: Path
    precision: str = "fp8"
    offload: str = "group-stream"
    blocks_per_group: int = 2
    # Off by default, and that is a measured decision rather than a cautious one.
    # Pinning moves weights at 22.3 GiB/s against 12.9 GiB/s pageable, so it is
    # worth 1.72x -- but `ModuleGroup._to_cpu` pins by allocating a *new* tensor
    # while the module still references the original, so the host cost doubles:
    #   fp8 transformer 17.69 + pinned 17.69 + fp8 encoder 11.14 + pinned 11.14
    #   = 57.66 GiB
    # against ~45 GiB usable. Enabling it on this machine drove RAM to 63.4 of
    # 63.6 GB and the run never reached the GPU. Turn it on when host RAM grows,
    # or once the text encoder is moved to disk-backed offload.
    pin_weights: bool = False
    # Where "group-disk" parks weights. Group offloading writes each block to
    # safetensors here and drops its host copy, which is the only way the two
    # large components coexist on a 64 GB machine.
    disk_offload_dir: Path | None = None
    # A pre-quantized transformer, loaded straight at its on-disk size. This is
    # the only way to get a quantized transformer onto this machine: converting
    # a bf16 checkpoint at load time needs `W_bf16 + W_quant` of host RAM --
    # 53 GiB for this model -- and measured, it filled 63.4 of 63.6 GB without
    # ever reaching the GPU.
    transformer_gguf: Path | None = None
    # A text encoder already quantized on disk, produced by
    # `quantize_text_encoder.py`. At fp8 it is 11.14 GiB, under the card's ~13 GiB
    # resident budget, so the encode stage stops needing offload -- which matters
    # because diffusers' group offloading does not chunk a transformers model and
    # onloaded all 22.28 GiB of the bf16 encoder in one piece, spilling 6.38 GiB.
    text_encoder_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.precision not in PRECISIONS:
            raise ValueError(f"precision must be one of {PRECISIONS}, got {self.precision!r}")
        if self.offload not in OFFLOADS:
            raise ValueError(f"offload must be one of {OFFLOADS}, got {self.offload!r}")
        if not 1 <= self.blocks_per_group <= 32:
            raise ValueError(f"blocks_per_group must be 1..32, got {self.blocks_per_group}")


@dataclasses.dataclass(frozen=True)
class LoadReport:
    seconds: float
    precision: str
    offload: str
    pinned: bool
    vram_allocated_gib: float
    vram_reserved_gib: float
    vram_free_gib: float
    host_rss_gib: float


def host_rss_gib() -> float:
    import psutil

    return psutil.Process().memory_info().rss / GIB


def device_total_gib() -> float:
    return torch.cuda.get_device_properties(0).total_memory / GIB


def vram_spill_gib() -> float:
    """How much of what CUDA thinks is device memory is actually system RAM.

    On WDDM the driver satisfies allocations past the card's capacity out of
    system RAM instead of raising, so `torch.OutOfMemoryError` never arrives and
    the run simply crawls -- every touch of a spilled page crosses PCIe at
    pageable speed. Reserved bytes beyond the physical card are that spill.
    """
    return max(0.0, torch.cuda.memory_reserved() / GIB - device_total_gib())


def vram_snapshot() -> dict[str, float]:
    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_gib": torch.cuda.memory_allocated() / GIB,
        "reserved_gib": torch.cuda.memory_reserved() / GIB,
        "peak_allocated_gib": torch.cuda.max_memory_allocated() / GIB,
        "peak_reserved_gib": torch.cuda.max_memory_reserved() / GIB,
        "free_gib": free / GIB,
        "total_gib": total / GIB,
        "spill_gib": vram_spill_gib(),
    }


def _weight_only_config(precision: str) -> Any:
    """The torchao config for `precision`.

    fp8 is E4M3 weight-only. Ada has native FP8 tensor cores but no FP4, so an
    int4 or NVFP4 checkpoint would be dequantized on the way in and cost more
    than it saves on this card.
    """
    if precision == "fp8":
        from torchao.quantization import Float8WeightOnlyConfig

        return Float8WeightOnlyConfig()

    from torchao.quantization import Int8WeightOnlyConfig

    return Int8WeightOnlyConfig()


def _load_text_encoder(config: LoadConfig) -> Any | None:
    """Load a pre-quantized text encoder, or None to let the pipeline load it."""
    if config.text_encoder_dir is None:
        return None
    if not config.text_encoder_dir.is_dir():
        raise FileNotFoundError(f"quantized text encoder not found: {config.text_encoder_dir}")

    import transformers

    source = config.text_encoder_dir
    architectures = getattr(transformers.AutoConfig.from_pretrained(source), "architectures", None)
    cls = transformers.AutoModelForCausalLM
    if architectures:
        cls = getattr(transformers, architectures[0], cls)
    return cls.from_pretrained(source, dtype=torch.bfloat16, device_map="cpu")


def _text_encoder_quantization(precision: str) -> Any | None:
    """Quantization for the text encoder only.

    The transformer is loaded and quantized separately, before the pipeline is
    built, so it is deliberately absent from this mapping.
    """
    if precision == "bf16":
        return None

    from diffusers import PipelineQuantizationConfig
    from transformers import TorchAoConfig as TransformersTorchAoConfig

    # The text encoder is a transformers class, so its config has to come from
    # transformers even though the pipeline is a diffusers one. Both accept the
    # same torchao config object.
    return PipelineQuantizationConfig(
        quant_mapping={"text_encoder": TransformersTorchAoConfig(_weight_only_config(precision))}
    )


# The two modulation blocks diffusers' LTX-2 converter leaves under their
# original checkpoint names. Everything else of the 4091 keys lines up.
_PROMPT_ADALN_RENAMES = (
    ("audio_prompt_adaln_single", "audio_prompt_adaln"),
    ("prompt_adaln_single", "prompt_adaln"),
)


def _patch_ltx2_converter() -> None:
    """Rename the 12 keys diffusers' LTX-2 single-file converter misses.

    `convert_ltx2_transformer_to_diffusers` strips the `_single` suffix from the
    main modulation blocks but not from `prompt_adaln_single` and
    `audio_prompt_adaln_single`. The resulting state dict is the right length --
    4091 keys either way -- so nothing complains at conversion time; the twelve
    unmatched parameters simply stay on the meta device and the load dies later
    with "Cannot copy out of meta tensor", pointing nowhere near the cause.

    Patched at the registry entry rather than the module attribute, because
    `SINGLE_FILE_LOADABLE_CLASSES` captured the original function object.
    """
    from diffusers.loaders.single_file_model import SINGLE_FILE_LOADABLE_CLASSES

    entry = SINGLE_FILE_LOADABLE_CLASSES["LTX2VideoTransformer3DModel"]
    original = entry["checkpoint_mapping_fn"]
    if getattr(original, "_ltx25_prompt_adaln_patch", False):
        return

    def patched(checkpoint: dict, **kwargs: Any) -> dict:
        converted = original(checkpoint, **kwargs)
        for old, new in _PROMPT_ADALN_RENAMES:
            prefix = f"{old}."
            for key in [k for k in converted if k.startswith(prefix)]:
                converted[new + key[len(old) :]] = converted.pop(key)
        return converted

    patched._ltx25_prompt_adaln_patch = True
    entry["checkpoint_mapping_fn"] = patched


def _load_transformer(config: LoadConfig) -> Any:
    """Load the transformer on its own, before anything else claims host RAM.

    Two paths. With `transformer_gguf` the weights arrive already quantized and
    are simply read -- 17.34 GiB for Q6_K against 35.38 GiB at bf16. Without it,
    the bf16 checkpoint is loaded and optionally converted, which only works when
    `W_bf16 + W_quant` fits in host RAM; for this model it does not.
    """
    from diffusers import LTX2VideoTransformer3DModel

    if config.transformer_gguf is not None:
        from diffusers import GGUFQuantizationConfig

        _patch_ltx2_converter()

        if not config.transformer_gguf.is_file():
            raise FileNotFoundError(f"GGUF transformer not found: {config.transformer_gguf}")
        # `config=` points at the diffusers config beside the bf16 weights: the
        # GGUF carries tensors and the original LTX names, not a diffusers config.
        return LTX2VideoTransformer3DModel.from_single_file(
            str(config.transformer_gguf),
            quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            config=str(config.model_dir / "transformer"),
            dtype=torch.bfloat16,
        )

    from diffusers import TorchAoConfig as DiffusersTorchAoConfig

    kwargs: dict[str, Any] = {"subfolder": "transformer", "dtype": torch.bfloat16}
    if config.precision != "bf16":
        kwargs["quantization_config"] = DiffusersTorchAoConfig(_weight_only_config(config.precision))

    return LTX2VideoTransformer3DModel.from_pretrained(config.model_dir, **kwargs)


def _enable_tiling(pipe: Any) -> None:
    """Bound decode memory by tile size rather than by clip size.

    Decoding 121 frames at 960x544 in one piece needs activations far past this
    card: measured without tiling, the driver pushed 22.22 GiB into system RAM
    and a single clip had not finished after twelve minutes. Tiling is not an
    optimisation here, it is what keeps the decode on the GPU at all.
    """
    # `diffusion_decoder` is not in this list because it is never loaded; see
    # where the pipeline kwargs are built.
    for component in ("vae",):
        module = getattr(pipe, component, None)
        if module is None:
            continue
        if hasattr(module, "enable_tiling"):
            module.enable_tiling()
        if hasattr(module, "enable_slicing"):
            module.enable_slicing()


def _group_offload_kwargs(config: LoadConfig) -> dict[str, Any]:
    use_stream = config.offload in {"group-stream", "group-disk"}
    kwargs: dict[str, Any] = {
        "onload_device": torch.device("cuda"),
        "offload_device": torch.device("cpu"),
        "offload_type": "block_level",
        "num_blocks_per_group": config.blocks_per_group,
        # False on purpose. The staging buffer is not pinned (that is what
        # `low_cpu_mem_usage=True` means), and an async copy out of pageable
        # memory goes through a driver staging path rather than straight to
        # the device. Measured below.
        "non_blocking": False,
        "use_stream": use_stream,
        "record_stream": use_stream,
        "low_cpu_mem_usage": not config.pin_weights,
    }
    if config.offload == "group-disk":
        if config.disk_offload_dir is None:
            raise ValueError("offload=group-disk requires disk_offload_dir")
        config.disk_offload_dir.mkdir(parents=True, exist_ok=True)
        kwargs["offload_to_disk_path"] = str(config.disk_offload_dir)
    return kwargs


def _apply_offload(pipe: Any, config: LoadConfig) -> None:
    cuda = torch.device("cuda")

    if config.offload == "none":
        # Only correct if the whole pipeline fits. It will not raise if it does
        # not: on WDDM the driver quietly backs the overflow with system RAM.
        pipe.to(cuda)
        return

    if config.offload == "model":
        pipe.enable_model_cpu_offload()
        return

    if config.offload == "sequential":
        pipe.enable_sequential_cpu_offload()
        return

    # Group offload is applied to the transformer alone, never to the pipeline.
    #
    # At pipeline level diffusers hooks every component, and the ones it cannot
    # split into blocks -- the text encoder, the connectors -- get onloaded whole.
    # Measured, that put the 12.60 GiB encoder and the 5.91 GiB connectors on the
    # card together during the encode stage: 18.5 GiB against 16, spilling 2.31.
    # The other components are moved by `stages.py`, one stage at a time.
    # Every group mode is already hooked at load time, before the pipeline was
    # built, because the order is what keeps host RAM under its limit.


def _offload_text_encoder(pipe: Any, offload_dir: Path) -> None:
    """Stream the bf16 text encoder from disk, one submodule at a time.

    Disk rather than host RAM, because the two large components do not fit there
    together: 35.38 + 22.28 = 57.7 GiB against roughly 48 free. Whichever one
    loses its RAM residency should be the one used least, and the transformer
    runs eight times per clip against the encoder's once per prompt. Measured,
    a transformer streaming from host RAM costs 4.24 s per step and one streaming
    from NVMe costs 32.1 s, so the encoder is the cheap thing to give up.

    Not diffusers' group offloading, which is what the transformer uses. Pointed
    at a transformers model that machinery breaks four separate ways: its block
    scan only looks at direct children so the whole 22.28 GiB is treated as one
    group; the lazy hook registers without checking for duplicates and Gemma's
    chain contains `model` twice; `send_to_device` rebuilds `shared_kv_states`
    and the rope shapes stop matching; and `lm_head`'s weight tying breaks once
    the embedding it aliases has been released. The first three can be worked
    around with `block_modules`, `use_stream=False` and `exclude_kwargs`; the
    fourth cannot be fixed from outside the model.

    `accelerate.cpu_offload` comes at it from the other side. It is the
    offloading transformers itself uses, so it already knows about shared KV
    state and tied weights, and it registers one hook per module.
    """
    from accelerate import disk_offload

    offload_dir.mkdir(parents=True, exist_ok=True)
    disk_offload(pipe.text_encoder, offload_dir=str(offload_dir), execution_device=torch.device("cuda"))


def load_pipeline(config: LoadConfig) -> tuple[Any, LoadReport]:
    """Build an `LTX2Pipeline` for the distilled checkpoint."""
    from diffusers import LTX2Pipeline

    if not config.model_dir.is_dir():
        raise FileNotFoundError(f"model directory does not exist: {config.model_dir}")
    if not (config.model_dir / "model_index.json").is_file():
        raise FileNotFoundError(f"not a diffusers pipeline directory (no model_index.json): {config.model_dir}")

    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()

    transformer = _load_transformer(config)
    if config.offload.startswith("group"):
        # Hooked now, before the text encoder allocates anything, so that 35.38
        # GiB of transformer and 22.28 GiB of text encoder are never both live.
        #
        # This used to apply to `group-disk` only. Extending it to every group
        # mode is correct on its own terms, but measured it changed nothing:
        # 8.10 s per step before and after, host RAM 58.3 then 58.4 GiB. The
        # ordering was not what made the arm slower than the same weights driven
        # by a standalone script -- see the note on stage parking in `stages.py`.
        transformer.enable_group_offload(**_group_offload_kwargs(config))
    # Drop the bf16 shard buffers before the text encoder starts allocating.
    gc.collect()

    kwargs: dict[str, Any] = {"dtype": torch.bfloat16, "transformer": transformer}

    text_encoder = _load_text_encoder(config)
    if text_encoder is not None:
        # Already quantized on disk; asking the pipeline to quantize again would
        # reload the bf16 original first and undo the point of doing it offline.
        kwargs["text_encoder"] = text_encoder
    else:
        quantization = _text_encoder_quantization(config.precision)
        if quantization is not None:
            kwargs["quantization_config"] = quantization

    # The prompt enhancer is a 9.51 GiB Gemma that rewrites the prompt and is
    # wanted by a minority of jobs. Declined here unconditionally and attached by
    # `refine.enhanced_prompt` for the jobs that ask, so its host RAM is not held
    # for the ones that do not.
    kwargs["prompt_enhancer"] = None
    # Declined outright rather than loaded and parked. `_decode` uses `vae` alone,
    # and the diffusion decoder cannot run on this machine regardless: it resolves
    # a NATTEN kernel through `get_kernel("shi-labs/natten")`, a repo that returns
    # 404. Loading it cost 0.78 GiB of host RAM, which on a machine peaking at
    # 58.3 of 59.2 GiB is not free.
    kwargs["diffusion_decoder"] = None

    pipe = LTX2Pipeline.from_pretrained(config.model_dir, **kwargs)
    # Left on. A step on this machine takes long enough that a run with no
    # progress output is indistinguishable from a hung one -- which is exactly
    # how the first benchmark looked.
    pipe.set_progress_bar_config(disable=False)
    _enable_tiling(pipe)
    _apply_offload(pipe, config)
    # An unquantized encoder cannot be resident: 22.28 GiB against a 13 GiB
    # budget. `stages.py` would otherwise place it whole and spill 5.21 GiB.
    # Resident for the life of the arm. See the note above `STAGE_MODULES`.
    if getattr(pipe, "connectors", None) is not None:
        pipe.connectors.to(torch.device("cuda"))

    if text_encoder is None and config.precision == "bf16":
        root = config.disk_offload_dir or (config.model_dir.parent / "ltx25-offload")
        _offload_text_encoder(pipe, root / "text-encoder")

    gc.collect()
    snapshot = vram_snapshot()
    report = LoadReport(
        seconds=time.perf_counter() - started,
        precision=config.precision,
        offload=config.offload,
        pinned=config.pin_weights and config.offload == "group-stream",
        vram_allocated_gib=snapshot["allocated_gib"],
        vram_reserved_gib=snapshot["reserved_gib"],
        vram_free_gib=snapshot["free_gib"],
        host_rss_gib=host_rss_gib(),
    )
    return pipe, report

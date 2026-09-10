"""Quantize the Gemma-4-12B text encoder to fp8 once, and save it.

Why this is a separate script rather than a load-time option:

Converting at load costs `W_bf16 + W_quant` of host RAM while both copies exist
-- 22.28 + 11.14 = 33.4 GiB for this component. That fits on its own, but not
beside the 17.34 GiB transformer the arm has already loaded by then: 50.8 GiB
against ~45 usable. Run alone, nothing else is resident and the conversion fits
with room to spare. Afterwards the arm reads 11.14 GiB straight from disk.

    .venv/Scripts/python.exe quantize_text_encoder.py \
        --model ../../storage/models/ltx-2.5-distilled \
        --out ../../storage/models/ltx-2.5-text-encoder-fp8

11.14 GiB also puts the text encoder under the card's ~13 GiB resident budget,
so the encode stage stops needing offload at all.
"""

from __future__ import annotations

import argparse
import gc
import time
from pathlib import Path

import psutil
import torch
from transformers import AutoConfig, AutoModelForCausalLM, TorchAoConfig

GIB = 1024**3


def rss() -> float:
    return psutil.virtual_memory().used / GIB


def main() -> None:
    parser = argparse.ArgumentParser(prog="quantize_text_encoder.py", description=__doc__)
    parser.add_argument("--model", required=True, help="the LTX-2.5 diffusers pipeline directory")
    parser.add_argument("--out", required=True, help="where to write the quantized text encoder")
    parser.add_argument("--precision", default="fp8", choices=("fp8", "int8"))
    args = parser.parse_args()

    source = Path(args.model).resolve() / "text_encoder"
    target = Path(args.out).resolve()
    if not source.is_dir():
        raise SystemExit(f"no text_encoder at {source}")

    if args.precision == "fp8":
        from torchao.quantization import Float8WeightOnlyConfig as WeightOnly
    else:
        from torchao.quantization import Int8WeightOnlyConfig as WeightOnly

    # The class is named in the pipeline's model_index.json rather than in the
    # component config, so it is resolved from the config's architecture instead
    # of hard-coding a Gemma variant that a future revision may rename.
    config = AutoConfig.from_pretrained(source)
    architecture = getattr(config, "architectures", None)
    print(f"architecture: {architecture}", flush=True)

    import transformers

    cls = AutoModelForCausalLM
    if architecture:
        candidate = getattr(transformers, architecture[0], None)
        if candidate is not None:
            cls = candidate
    print(f"loading with {cls.__name__} (ram {rss():.1f} GiB)", flush=True)

    started = time.perf_counter()
    model = cls.from_pretrained(
        source,
        dtype=torch.bfloat16,
        quantization_config=TorchAoConfig(WeightOnly()),
        device_map="cpu",
    )
    print(f"loaded+quantized in {time.perf_counter() - started:.1f}s (ram {rss():.1f} GiB)", flush=True)

    gc.collect()
    target.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    # torchao tensors are not plain tensors, so safetensors cannot serialise them.
    model.save_pretrained(target, safe_serialization=False)
    print(f"saved in {time.perf_counter() - started:.1f}s -> {target}", flush=True)

    written = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
    print(f"on disk: {written / 1e9:.2f} GB / {written / GIB:.2f} GiB", flush=True)


if __name__ == "__main__":
    main()

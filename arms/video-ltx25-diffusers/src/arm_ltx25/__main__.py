"""Entry point. Every knob here is fixed at start because it decides how the
36 GiB (bf16) or 18 GiB (fp8) transformer is placed, which cannot change without
reloading it."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .loading import OFFLOADS, PRECISIONS, LoadConfig
from .server import ArmState, serve

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_ltx25")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", required=True, help="diffusers pipeline directory")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument("--offload-dir", required=True, help="scratch root for offload=group-disk")
    parser.add_argument("--transformer-gguf", default="", help="pre-quantized transformer file, inside storage")
    parser.add_argument("--text-encoder-dir", default="", help="pre-quantized text encoder directory")
    parser.add_argument("--precision", default="bf16", choices=PRECISIONS)
    parser.add_argument("--offload", default="group-stream", choices=OFFLOADS)
    parser.add_argument("--blocks-per-group", type=int, default=1)
    parser.add_argument(
        "--pin-weights",
        default="false",
        choices=("true", "false"),
        help="pin the offload staging buffer; doubles host RAM, see LoadConfig",
    )
    args = parser.parse_args()
    quantized = args.precision != "bf16"

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    import torch

    if not torch.cuda.is_available():
        print("[video-ltx25-diffusers] no CUDA device visible", file=sys.stderr, flush=True)
        raise SystemExit(1)

    try:
        config = LoadConfig(
            model_dir=Path(args.model),
            precision=args.precision,
            offload=args.offload,
            blocks_per_group=args.blocks_per_group,
            pin_weights=args.pin_weights == "true",
            disk_offload_dir=Path(args.offload_dir),
            # bf16 means unquantized, whatever paths were supplied. The manifest
            # always resolves these two because a placeholder cannot be omitted
            # conditionally, so the precision is what decides whether they apply.
            transformer_gguf=(
                Path(args.transformer_gguf) if args.transformer_gguf and quantized else None
            ),
            text_encoder_dir=(
                Path(args.text_encoder_dir) if args.text_encoder_dir and quantized else None
            ),
        )
    except ValueError as error:
        parser.error(str(error))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    serve(args.host, args.port, ArmState(config, out_dir))


if __name__ == "__main__":
    main()

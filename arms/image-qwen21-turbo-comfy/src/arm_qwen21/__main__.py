"""Entry point.

Every knob here is fixed at start because it decides how ComfyUI reads its
weights, which cannot change without restarting it -- which is exactly the
distinction the supervisor's broker acts on: a job whose start parameters
differ from the loaded arm's restarts the arm, and one whose parameters match
reuses it.
"""

from __future__ import annotations

import argparse
import atexit
from pathlib import Path

from .runtime import ATTENTION_FLAGS, CACHE_MODE_FLAGS, VRAM_MODE_FLAGS, LoadConfig
from .server import ArmState, serve

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
DEFAULT_COMFY_DIR = Path("vendor") / "ComfyUI"
DEFAULT_CUSTOM_NODES = Path("custom_nodes")
WEIGHT_DTYPES = ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2")


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_qwen21")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--comfy-dir",
        default=str(DEFAULT_COMFY_DIR),
        help="ComfyUI checkout, relative to this arm's directory",
    )
    parser.add_argument(
        "--custom-nodes-dir",
        default=str(DEFAULT_CUSTOM_NODES),
        help="where this arm keeps Viggle's ComfyUI nodes",
    )
    parser.add_argument("--diffusion-model", required=True, help="Qwen-Image 2.1 transformer")
    parser.add_argument("--text-encoder", required=True, help="Qwen3-VL 8B")
    parser.add_argument("--vae", required=True, help="Qwen-Image 2.1 VAE")
    parser.add_argument("--turbo-lora", required=True, help="viggle-turbo LoRA")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument(
        "--input-dir", required=True, help="root that a job's reference images are confined to"
    )
    parser.add_argument(
        "--scratch-dir", required=True, help="where ComfyUI keeps its own output, temp and user files"
    )
    parser.add_argument("--weight-dtype", default="fp8_e4m3fn", choices=WEIGHT_DTYPES)
    parser.add_argument("--text-encoder-device", default="default", choices=("default", "cpu"))
    parser.add_argument("--vram-mode", default="dynamic", choices=tuple(VRAM_MODE_FLAGS))
    parser.add_argument("--attention", default="pytorch", choices=tuple(ATTENTION_FLAGS))
    parser.add_argument("--reserve-vram", type=float, default=0.8)
    parser.add_argument("--cache-mode", default="ram", choices=tuple(CACHE_MODE_FLAGS))
    parser.add_argument("--kv-cache-device", default="auto", choices=("auto", "gpu", "cpu", "off"))
    parser.add_argument("--kv-cache-dtype", default="default", choices=("default", "int8", "int4"))
    parser.add_argument("--extra-args", default="", help="passed through to ComfyUI verbatim")
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    comfy_dir = Path(args.comfy_dir).resolve()
    if not (comfy_dir / "main.py").is_file():
        # Not fatal: the arm still starts, answers its health check, and says
        # this again -- with the same words -- to the first job that needs it.
        # Failing here instead would surface as an opaque launch timeout.
        print(f"[arm] warning: {comfy_dir} has no main.py; no job can run until it does", flush=True)

    custom_nodes_dir = Path(args.custom_nodes_dir).resolve()
    if not (custom_nodes_dir / "viggle_turbo" / "__init__.py").is_file():
        print(f"[arm] warning: {custom_nodes_dir} has no viggle_turbo node; no job can run", flush=True)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    in_dir = Path(args.input_dir)
    in_dir.mkdir(parents=True, exist_ok=True)
    scratch_dir = Path(args.scratch_dir)
    scratch_dir.mkdir(parents=True, exist_ok=True)

    config = LoadConfig(
        comfy_dir=comfy_dir,
        diffusion_model=Path(args.diffusion_model),
        text_encoder=Path(args.text_encoder),
        vae=Path(args.vae),
        turbo_lora=Path(args.turbo_lora),
        custom_nodes_dir=custom_nodes_dir,
        input_dir=in_dir.resolve(),
        scratch_dir=scratch_dir.resolve(),
        weight_dtype=args.weight_dtype,
        text_encoder_device=args.text_encoder_device,
        vram_mode=args.vram_mode,
        attention=args.attention,
        reserve_vram=args.reserve_vram,
        cache_mode=args.cache_mode,
        kv_cache_device=args.kv_cache_device,
        kv_cache_dtype=args.kv_cache_dtype,
        extra_args=args.extra_args,
    )

    state = ArmState(config, out_dir, in_dir)
    # The supervisor kills this arm's whole process tree, so the child normally
    # goes with it. This covers the other ways this process can end.
    atexit.register(state.shutdown)

    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

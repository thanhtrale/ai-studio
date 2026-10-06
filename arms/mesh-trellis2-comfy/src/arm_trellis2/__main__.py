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
# Shared with the image arm rather than cloned: the same ComfyUI build already
# carries every node this graph uses, and a second checkout would be a second
# torch install to keep in step with the first. See the README.
DEFAULT_COMFY_DIR = Path("..") / "image-qwen-edit-comfy" / "vendor" / "ComfyUI"
WEIGHT_DTYPES = ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2")


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_trellis2")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--comfy-dir",
        default=str(DEFAULT_COMFY_DIR),
        help="ComfyUI checkout, relative to this arm's directory",
    )
    parser.add_argument("--diffusion-model", required=True, help="trellis_2_*.safetensors")
    parser.add_argument("--clip-vision", required=True, help="dino_v3_vit_l.safetensors")
    parser.add_argument("--shape-vae", required=True, help="trellis_2_shape_vae_bf16.safetensors")
    parser.add_argument("--texture-vae", required=True, help="trellis_2_texture_vae_bf16.safetensors")
    parser.add_argument("--bg-model", required=True, help="birefnet.safetensors")
    parser.add_argument("--weight-dtype", default="default", choices=WEIGHT_DTYPES)
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument(
        "--input-dir", required=True, help="root that a job's reference images are confined to"
    )
    parser.add_argument(
        "--scratch-dir", required=True, help="where ComfyUI keeps its own output, temp and user files"
    )
    parser.add_argument("--vram-mode", default="dynamic", choices=tuple(VRAM_MODE_FLAGS))
    parser.add_argument("--attention", default="pytorch", choices=tuple(ATTENTION_FLAGS))
    parser.add_argument("--reserve-vram", type=float, default=0.8)
    parser.add_argument("--cache-mode", default="ram", choices=tuple(CACHE_MODE_FLAGS))
    parser.add_argument("--extra-args", default="", help="passed through to ComfyUI verbatim")
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    comfy_dir = Path(args.comfy_dir).resolve()
    if not (comfy_dir / "main.py").is_file():
        print(f"[arm] warning: {comfy_dir} has no main.py; no job can run until it does", flush=True)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    in_dir = Path(args.input_dir)
    in_dir.mkdir(parents=True, exist_ok=True)
    scratch_dir = Path(args.scratch_dir)
    scratch_dir.mkdir(parents=True, exist_ok=True)

    config = LoadConfig(
        comfy_dir=comfy_dir,
        diffusion_model=Path(args.diffusion_model),
        clip_vision=Path(args.clip_vision),
        shape_vae=Path(args.shape_vae),
        texture_vae=Path(args.texture_vae),
        bg_model=Path(args.bg_model),
        weight_dtype=args.weight_dtype,
        input_dir=in_dir.resolve(),
        scratch_dir=scratch_dir.resolve(),
        vram_mode=args.vram_mode,
        attention=args.attention,
        reserve_vram=args.reserve_vram,
        cache_mode=args.cache_mode,
        extra_args=args.extra_args,
    )

    state = ArmState(config, out_dir, in_dir)
    atexit.register(state.shutdown)

    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

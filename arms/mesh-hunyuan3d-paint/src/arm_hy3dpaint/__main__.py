"""Entry point. Weight locations are start parameters; everything else is per job."""

from __future__ import annotations

import argparse
import atexit
import os
from pathlib import Path

from .engine import Engine, Paths
from .server import ArmState, serve

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_hy3dpaint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--shape-dir", required=True, help="hunyuan3d-dit-v2-1 (config.yaml + model.fp16.ckpt)"
    )
    parser.add_argument("--paint-dir", required=True, help="hunyuan3d-paintpbr-v2-1, a diffusers folder")
    parser.add_argument("--dino-dir", required=True, help="facebook/dinov2-giant")
    parser.add_argument("--upscaler", required=True, help="RealESRGAN_x4plus.pth")
    parser.add_argument("--rembg-dir", required=True, help="where rembg keeps its cut-out models")
    parser.add_argument("--rembg-model", default="birefnet-general")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument(
        "--input-dir", required=True, help="root that a job's images and meshes are confined to"
    )
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    in_dir = Path(args.input_dir)
    in_dir.mkdir(parents=True, exist_ok=True)
    rembg_dir = Path(args.rembg_dir).resolve()
    rembg_dir.mkdir(parents=True, exist_ok=True)
    os.environ["U2NET_HOME"] = str(rembg_dir)

    paths = Paths(
        shape_dir=Path(args.shape_dir).resolve(),
        paint_dir=Path(args.paint_dir).resolve(),
        dino_dir=Path(args.dino_dir).resolve(),
        upscaler=Path(args.upscaler).resolve(),
        rembg_home=rembg_dir,
        rembg_model=args.rembg_model,
    )
    for name, path in (
        ("shape-dir", paths.shape_dir),
        ("paint-dir", paths.paint_dir),
        ("dino-dir", paths.dino_dir),
    ):
        if not path.is_dir():
            print(f"[arm] warning: --{name} {path} is not there; jobs that need it will fail", flush=True)

    state = ArmState(Engine(paths), out_dir, in_dir)
    atexit.register(state.shutdown)
    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

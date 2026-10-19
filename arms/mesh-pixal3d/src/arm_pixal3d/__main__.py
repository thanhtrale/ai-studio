"""Entry point. Weight locations are start parameters; everything else is per job."""

from __future__ import annotations

import argparse
import atexit
from pathlib import Path

from .engine import Engine, Paths
from .server import ArmState, serve

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_pixal3d")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--model-dir", required=True, help="TencentARC/Pixal3D snapshot (pipeline.json + ckpts/)"
    )
    parser.add_argument("--hf-home", required=True, help="HF cache with DINOv3 and MoGe-2")
    parser.add_argument("--torch-home", required=True, help="torch.hub cache with valeoai/NAF")
    parser.add_argument("--rembg-dir", required=True, help="where rembg keeps its cut-out models")
    parser.add_argument("--rembg-model", default="birefnet-general")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument("--input-dir", required=True, help="root that a job's image is confined to")
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    in_dir = Path(args.input_dir)
    in_dir.mkdir(parents=True, exist_ok=True)
    paths = Paths(
        model_dir=Path(args.model_dir).resolve(),
        hf_home=Path(args.hf_home).resolve(),
        torch_home=Path(args.torch_home).resolve(),
        rembg_home=Path(args.rembg_dir).resolve(),
        rembg_model=args.rembg_model,
    )
    if not (paths.model_dir / "pipeline.json").is_file():
        print(
            f"[arm] warning: --model-dir {paths.model_dir} has no pipeline.json; jobs will fail", flush=True
        )

    state = ArmState(Engine(paths), out_dir, in_dir)
    atexit.register(state.shutdown)
    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

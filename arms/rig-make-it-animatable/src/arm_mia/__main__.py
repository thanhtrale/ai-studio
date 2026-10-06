"""Entry point. Weight and clip locations are start parameters; the rest is per job."""

from __future__ import annotations

import argparse
import atexit
import os
from pathlib import Path

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_mia")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--hy3d-models", required=True, help="holds tencent/Hunyuan3D-2.1/hunyuan3d-vae-v2-1")
    parser.add_argument(
        "--template", required=True, help="a Mixamo FBX whose armature is the template skeleton"
    )
    parser.add_argument("--clip-dir", required=True, help="Mixamo clips, one .fbx per clip, named as listed")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--scratch-dir", required=True)
    args = parser.parse_args()
    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    # Before the vendored code is imported: it reads this at load time.
    os.environ["HY3DGEN_MODELS"] = str(Path(args.hy3d_models).resolve())

    from .engine import Engine
    from .server import ArmState, serve

    out_dir, in_dir = Path(args.out_dir), Path(args.input_dir)
    scratch = Path(args.scratch_dir).resolve()
    for path in (out_dir, in_dir, scratch, Path(args.clip_dir)):
        path.mkdir(parents=True, exist_ok=True)
    template = Path(args.template).resolve()
    if not template.is_file():
        print(f"[arm] warning: --template {template} is not there; no rig can be exported", flush=True)

    state = ArmState(Engine(), out_dir, in_dir, Path(args.clip_dir).resolve(), template, scratch)
    atexit.register(state.shutdown)
    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

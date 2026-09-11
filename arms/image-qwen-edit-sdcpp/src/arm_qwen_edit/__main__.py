"""Entry point.

Every knob here is fixed at start because it decides how the child process
reads its weights, which cannot change without restarting it -- which is
exactly the distinction the supervisor's broker acts on: a job whose start
parameters differ from the loaded arm's restarts the arm, and one whose
parameters match reuses it.
"""

from __future__ import annotations

import argparse
import atexit
from pathlib import Path

from .runtime import LoadConfig
from .server import ArmState, serve

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
DEFAULT_BINARY = Path("bin") / "sd-server.exe"


def _flag(value: str) -> bool:
    return value == "true"


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_qwen_edit")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--sd-server",
        default=str(DEFAULT_BINARY),
        help="stable-diffusion.cpp server binary, relative to this arm's directory",
    )
    parser.add_argument("--diffusion-model", required=True, help="Qwen-Image-Edit GGUF")
    parser.add_argument("--vae", required=True, help="qwen_image_vae.safetensors")
    parser.add_argument("--llm", required=True, help="Qwen2.5-VL text encoder")
    parser.add_argument("--llm-vision", default="", help="mmproj file, needed only by a GGUF encoder")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument(
        "--input-dir", required=True, help="root that a job's reference images are confined to"
    )
    parser.add_argument("--offload-to-cpu", default="true", choices=("true", "false"))
    parser.add_argument("--flash-attention", default="true", choices=("true", "false"))
    parser.add_argument("--threads", type=int, default=-1)
    parser.add_argument("--model-args", default="", help="passed through to the child verbatim")
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    binary = Path(args.sd_server).resolve()
    if not binary.is_file():
        # Not fatal: the arm still starts, answers its health check, and says
        # this again -- with the same words -- to the first job that needs it.
        # Failing here instead would surface as an opaque launch timeout.
        print(f"[arm] warning: {binary} is not there; no job can run until it is", flush=True)

    config = LoadConfig(
        server_binary=binary,
        diffusion_model=Path(args.diffusion_model),
        vae=Path(args.vae),
        llm=Path(args.llm),
        llm_vision=Path(args.llm_vision) if args.llm_vision else None,
        offload_to_cpu=_flag(args.offload_to_cpu),
        flash_attention=_flag(args.flash_attention),
        threads=args.threads,
        model_args=args.model_args,
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    in_dir = Path(args.input_dir)
    in_dir.mkdir(parents=True, exist_ok=True)

    state = ArmState(config, out_dir, in_dir)
    # The supervisor kills this arm's whole process tree, so the child normally
    # goes with it. This covers the other ways this process can end.
    atexit.register(state.shutdown)

    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

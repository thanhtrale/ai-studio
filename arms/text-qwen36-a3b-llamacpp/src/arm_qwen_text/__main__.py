"""Entry point.

Every knob here is fixed at start because it decides how the child process
places its weights, which cannot change without restarting it -- which is
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
DEFAULT_BINARY = Path("bin") / "llama-server.exe"


def _flag(value: str) -> bool:
    return value == "true"


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_qwen_text")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--llama-server",
        default=str(DEFAULT_BINARY),
        help="llama.cpp server binary, relative to this arm's directory",
    )
    parser.add_argument("--model", required=True, help="the GGUF")
    parser.add_argument("--mmproj", default="", help="vision projector, used only when --vision is true")
    parser.add_argument("--vision", default="false", choices=("true", "false"))
    parser.add_argument("--ctx-size", type=int, default=65536)
    parser.add_argument("--gpu-layers", type=int, default=999)
    parser.add_argument("--cpu-moe", type=int, default=22, help="layers whose experts stay in RAM")
    parser.add_argument("--flash-attn", default="auto", choices=("auto", "on", "off"))
    parser.add_argument("--threads", type=int, default=-1)
    parser.add_argument("--kv-cache-type", default="f16", choices=("f16", "bf16", "q8_0", "q4_0"))
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    binary = Path(args.llama_server).resolve()
    if not binary.is_file():
        # Not fatal: the arm still starts, answers its health check, and says
        # this again -- with the same words -- to the first job that needs it.
        # Failing here instead would surface as an opaque launch timeout.
        print(f"[arm] warning: {binary} is not there; no job can run until it is", flush=True)

    config = LoadConfig(
        server_binary=binary,
        model=Path(args.model),
        mmproj=Path(args.mmproj) if args.mmproj else None,
        vision=_flag(args.vision),
        context_size=args.ctx_size,
        gpu_layers=args.gpu_layers,
        cpu_moe=args.cpu_moe,
        flash_attention=args.flash_attn,
        threads=args.threads,
        kv_cache_type=args.kv_cache_type,
    )

    state = ArmState(config)
    # The supervisor kills this arm's whole process tree, so the child normally
    # goes with it. This covers the other ways this process can end.
    atexit.register(state.shutdown)

    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

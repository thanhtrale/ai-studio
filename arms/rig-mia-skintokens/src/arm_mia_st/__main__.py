"""Entry point, for both roles.

Everything here is fixed at start: where the vendored code and the second venv
are, and which directories a job's paths are confined to. A job changes none of
it, so the supervisor reuses a started arm for every job of its role.
"""

from __future__ import annotations

import argparse
import atexit
import sys
from pathlib import Path

from .server import ArmState, serve
from .tasks import ROLE_TASKS, Roots

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
ARM_DIR = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(prog="arm_mia_st")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--role", required=True, choices=tuple(ROLE_TASKS))
    parser.add_argument("--models-dir", required=True, help="the studio's models directory")
    parser.add_argument("--out-dir", required=True, help="root that every job output path is confined to")
    parser.add_argument("--input-dir", required=True, help="root that every job input path is confined to")
    parser.add_argument(
        "--mia-dir",
        default=str(ARM_DIR / "vendor" / "make-it-animatable"),
        help="Make-It-Animatable checkout, branch v2",
    )
    parser.add_argument(
        "--skintokens-dir", default=str(ARM_DIR / "vendor" / "SkinTokens"), help="SkinTokens checkout"
    )
    parser.add_argument(
        "--skintokens-python",
        default=str(ARM_DIR / ".venv-skintokens" / "Scripts" / "python.exe"),
        help="SkinTokens' own interpreter: it needs transformers >= 4.57, MIA needs 4.46",
    )
    args = parser.parse_args()

    if args.host not in LOOPBACK:
        parser.error("this arm binds loopback only")

    roots = Roots(
        inputs=Path(args.input_dir).resolve(),
        outputs=Path(args.out_dir).resolve(),
        models=Path(args.models_dir).resolve(),
    )
    for root in (roots.inputs, roots.outputs):
        root.mkdir(parents=True, exist_ok=True)

    mia_dir = Path(args.mia_dir).resolve()
    if args.role == "rig" and not (mia_dir / "app_v2.py").is_file():
        print(f"[arm] warning: {mia_dir} has no app_v2.py; no rig can run until it does", flush=True)

    env = {
        "MIA_DIR": str(mia_dir),
        "SKINTOKENS_DIR": str(Path(args.skintokens_dir).resolve()),
        "SKINTOKENS_PYTHON": str(Path(args.skintokens_python).resolve()),
        # MIA finds the Hunyuan3D 2.1 ShapeVAE through hy3dgen's own variable.
        "HY3DGEN_MODELS": str(roots.models / "rig" / "hy3dgen"),
        "AISTUDIO_MODELS_DIR": str(roots.models),
    }
    state = ArmState(args.role, roots, env, ARM_DIR / "scripts", Path(sys.executable))
    atexit.register(state.shutdown)
    serve(args.host, args.port, state)


if __name__ == "__main__":
    main()

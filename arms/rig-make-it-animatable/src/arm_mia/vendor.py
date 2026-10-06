"""Make the Make-It-Animatable v2 checkout importable, as it is cloned.

Its modules import each other as `util.*`, `model`, `app_v2` from the
checkout's root, and it reads its checkpoints from `output/best/v2/` relative
to that root -- so the root goes on `sys.path`, and the weights are reached
through a directory junction there rather than copied (see README.md).

Its ShapeVAE is Hunyuan3D 2.1's, which `hy3dshape` finds under
`$HY3DGEN_MODELS/tencent/Hunyuan3D-2.1/hunyuan3d-vae-v2-1`: the same weights
the Hunyuan3D paint arm already has, pointed at by the arm's launch.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "vendor" / "MIA"
_installed: Path | None = None


def install(root: Path = DEFAULT_ROOT) -> Path:
    global _installed
    if _installed is not None:
        return _installed
    root = root.resolve()
    if not (root / "app_v2.py").is_file():
        raise FileNotFoundError(
            f"{root} is not a Make-It-Animatable v2 checkout -- clone "
            "https://github.com/jasongzy/Make-It-Animatable -b v2 --recursive there (see README.md)"
        )
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    # Blender before anything else: `trimesh`'s extras and `pymeshlab` load
    # DLLs of their own that `bpy` then fails to bind against ("the specified
    # procedure could not be found"). Loaded first, both sides work.
    import bpy  # noqa: F401

    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
    _installed = root
    return root

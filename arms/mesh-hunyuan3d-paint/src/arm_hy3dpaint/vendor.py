"""Make Tencent's Hunyuan3D-2.1 checkout importable, without its build step.

The checkout is used as it is cloned: `hy3dshape` for the shape DiT and its
VAE, `hy3dpaint` for the multiview paint model and the renderer that projects
its views back onto the mesh. Nothing in it is edited. What it cannot have here
is what it compiles or what it borrows from Blender, so before any of it is
imported:

- `custom_rasterizer` -- a CUDA extension -- is `raster.py`
- `DifferentiableRenderer.mesh_inpaint_processor` -- a pybind11 extension -- is
  `inpaint.py`
- `bpy`, which `mesh_utils` imports only to write OBJ and GLB files, is not
  provided at all: `MeshRender` already survives its absence, and the GLB is
  written by `glb.py` instead

Both stand-ins are registered under the names the vendored code imports, so
`MeshRender` picks them up through its own `import` statements.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

from . import inpaint, raster

DEFAULT_VENDOR = Path(__file__).resolve().parents[2] / "vendor" / "Hunyuan3D-2.1"
_installed: Path | None = None


def install(root: Path = DEFAULT_VENDOR) -> Path:
    """Put the checkout on `sys.path` and the stand-ins in `sys.modules`. Idempotent."""
    global _installed
    if _installed is not None:
        return _installed

    root = root.resolve()
    shape = root / "hy3dshape"
    paint = root / "hy3dpaint"
    if not (shape / "hy3dshape" / "pipelines.py").is_file() or not (paint / "hunyuanpaintpbr").is_dir():
        raise FileNotFoundError(
            f"{root} is not a Hunyuan3D-2.1 checkout -- clone "
            "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1 there (see README.md)"
        )

    for path in (str(shape), str(paint)):
        if path not in sys.path:
            sys.path.insert(0, path)

    rasterizer = types.ModuleType("custom_rasterizer")
    rasterizer.rasterize = raster.rasterize  # type: ignore[attr-defined]
    rasterizer.interpolate = raster.interpolate  # type: ignore[attr-defined]
    sys.modules["custom_rasterizer"] = rasterizer

    kernel = types.ModuleType("custom_rasterizer_kernel")
    kernel.rasterize_image = raster.rasterize_image  # type: ignore[attr-defined]
    sys.modules["custom_rasterizer_kernel"] = kernel

    import DifferentiableRenderer  # noqa: F401 - the package must exist before its submodule

    processor = types.ModuleType("DifferentiableRenderer.mesh_inpaint_processor")
    processor.meshVerticeInpaint = inpaint.meshVerticeInpaint  # type: ignore[attr-defined]
    sys.modules["DifferentiableRenderer.mesh_inpaint_processor"] = processor

    _installed = root
    return root

"""Make-It-Animatable v2's three networks, held in this process, run headless.

The checkout's own entry point is a Gradio app (`app_v2.py`) whose pipeline is
five functions over a `DB` state object: `prepare_input`, `preprocess`,
`infer`, `vis`, `vis_blender`. The first four are pure model and geometry
work, and are called here exactly as the app calls them, in order, with the
app's own defaults. Their return values name Gradio components the app would
have built; nothing here reads them, so those names are bound to placeholders.

The fifth is Blender, and runs in a subprocess (`blend.py`).

What comes out of the four:

- `joints`, `joints_tail`: 65 Mixamo bones, head and tail, in the character's
  normalised frame
- `bw`: per-vertex skin weights over those bones
- `pose`: per-bone transforms that take the character's own pose to a T-pose,
  which is what every Mixamo clip is authored against
"""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from . import vendor

#: Gradio components `app_v2`'s functions return values for.
_COMPONENTS = (
    "state",
    "output_joints_coarse",
    "output_normed_input",
    "output_sample",
    "output_joints",
    "output_bw",
    "output_rest_lbs",
    "output_rest_vis",
    "output_anim",
    "output_anim_vis",
)


class Engine:
    def __init__(self) -> None:
        self.app: Any = None

    @property
    def loaded(self) -> bool:
        return self.app is not None

    def load(self) -> None:
        if self.app is not None:
            return
        root = vendor.install()
        here = os.getcwd()
        with contextlib.redirect_stdout(io.StringIO()):
            import app_v2

        for name in _COMPONENTS:
            setattr(app_v2, name, name)
        try:
            # It chdirs to its own root to find output/best/v2; put the
            # process back where it was so every other path stays meaningful.
            app_v2.init_models()
        finally:
            os.chdir(here)
        self.app = app_v2
        self.root = root

    def predict(self, mesh_path: Path, remove_fingers: bool, inplace: bool) -> dict[str, Any]:
        """Joints, weights and T-pose for one mesh, as the dict `rigdata` works on.

        `prepare_input` writes its intermediate GLBs beside the input, so
        `mesh_path` should be a copy in scratch rather than the library's file.
        """
        app = self.load() or self.app
        db = app.DB()
        app.clear(db)
        app.fix_random()

        app.prepare_input(str(mesh_path), False, 0.0, db, False)

        # Not at the top: trimesh's and scipy's DLLs must load after bpy's (`vendor.install`).
        from . import frame, surface, weights

        # A closed mesh is read as it is; the shell, rebuilt, is never as true to it.
        use_shell = not surface.is_closed(db.mesh)
        original = app.sample_mesh
        hips_transform = app.get_hips_transform
        if use_shell:
            self._sample_shell(db)
            app.sample_mesh = self._shell_sampler(db, original)
        # Upright: see `frame`. A tilted hips frame comes back as a twisted body.
        app.get_hips_transform = frame.upright(hips_transform)
        try:
            app.preprocess(db)
        finally:
            app.sample_mesh = original
            app.get_hips_transform = hips_transform
        app.infer(True, db)
        app.vis(True, "LeftArm", remove_fingers, False, db)

        bw = np.asarray(db.bw).reshape(len(db.mesh.vertices), -1)
        bw = weights.prune_far(bw, db.mesh.vertices, db.joints, db.joints_tail)
        bw = weights.clean(bw, db.mesh.vertices, db.faces, smooth=weights.SMOOTH_ROUNDS if use_shell else 0)

        return {
            "mesh": db.mesh,
            "joints": db.joints,
            "joints_tail": db.joints_tail,
            "bw": bw,
            "pose": frame.untwist(db.pose, db.joints, db.joints_tail) if db.pose is not None else None,
            "bones_idx_dict": dict(app.BONES_IDX_DICT),
            # Aligned with BONES_IDX_DICT: `vis` reads them together.
            "parents": np.asarray(app.KINEMATIC_TREE.parent_indices, dtype=np.int64),
            "options": json.dumps(
                {
                    "remove_fingers": remove_fingers,
                    "inplace": inplace,
                    # With the fingers folded in, a hand is a mitten, and the pose
                    # network reads a fist as a hand turned over -- 170-odd degrees
                    # that, made the rest, wrench the wrist. It follows the forearm.
                    "pose_ignore": [
                        *app.get_pose_ignore_list(None, None),
                        *(["Hand"] if remove_fingers else []),
                    ],
                }
            ),
        }

    def _sample_shell(self, db: Any) -> None:
        """Swap `prepare_input`'s samples and vertex normals for the outer shell's."""
        import torch

        from . import surface

        shell = surface.outer_shell(db.mesh)
        samples = self.app.sample_mesh(shell, db.pts.shape[1], get_normals=True).astype(np.float32)
        pts, pts_normal = torch.chunk(torch.from_numpy(samples).unsqueeze(0), 2, dim=-1)
        db.pts, db.pts_normal = pts, pts_normal
        verts = db.verts.squeeze(0).numpy()
        db.verts_normal = torch.from_numpy(surface.shell_normals(shell, verts)).unsqueeze(0)
        self._shell, self._verts = shell, verts

    def _shell_sampler(self, db: Any, original: Any) -> Any:
        """`sample_mesh` for `preprocess`'s second pass, which resamples around the hands.

        It samples `db.mesh` after moving its vertices into the hips frame. The
        shell is moved the same way -- the transform is recovered from the
        vertices, before and after -- and sampled instead.
        """

        def sample(mesh: Any, count: int, **kwargs: Any) -> np.ndarray:
            moved = np.asarray(mesh.vertices, dtype=np.float64)
            if moved.shape != self._verts.shape:
                return original(mesh, count, **kwargs)
            homogeneous = np.hstack([self._verts, np.ones((len(self._verts), 1))])
            affine, *_ = np.linalg.lstsq(homogeneous, moved, rcond=None)
            matrix = np.eye(4)
            matrix[:3] = affine.T
            return original(self._shell.copy().apply_transform(matrix), count, **kwargs)

        return sample

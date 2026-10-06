"""The outside of a mesh, for the networks to look at.

MIA reads a character as points sampled from its surface, each with a normal,
and it learnt from Mixamo characters: closed skins whose normals point out.
Image-to-3D meshes are often not that. TRELLIS.2 in particular writes a thin
two-sided shell in a hundred-odd pieces, half its faces wound inwards; sampled
as it is, the coarse network piles every joint in the chest.

So for such a mesh the samples, and the vertex normals the weight network
reads, come from a closed surface rebuilt around it: voxelised, its inside
filled, and meshed again with marching cubes. The vertices that are skinned
and exported stay the mesh's own.

Only for such a mesh: a closed one (Hunyuan3D writes them) is read as it is.
The rebuilt shell is a voxel coarser than the mesh, and on a closed mesh it
measurably costs more than it gives -- 24 edges stretched past twice their
length in a run cycle on one character became 250.
"""

from __future__ import annotations

import numpy as np
import trimesh
from scipy.spatial import cKDTree

#: Voxels along the longest side. 256 resolves fingers on a 1.8 m character.
RESOLUTION = 256


def is_closed(mesh: trimesh.Trimesh) -> bool:
    """Watertight once coincident vertices are merged -- UV seams split them."""
    return trimesh.Trimesh(mesh.vertices, mesh.faces).is_watertight


def outer_shell(mesh: trimesh.Trimesh, resolution: int = RESOLUTION) -> trimesh.Trimesh:
    pitch = float(mesh.extents.max()) / resolution
    grid = mesh.voxelized(pitch).fill()
    cubes = grid.marching_cubes
    cubes.apply_transform(grid.transform)
    # Rebuilt from faces alone: marching cubes hands over vertex normals that
    # follow the field's gradient, which points in.
    return trimesh.Trimesh(cubes.vertices, cubes.faces, process=False)


def shell_normals(shell: trimesh.Trimesh, points: np.ndarray) -> np.ndarray:
    """Each point's normal: that of the nearest vertex of the shell."""
    _, nearest = cKDTree(shell.vertices).query(points)
    return np.asarray(shell.vertex_normals, dtype=np.float32)[nearest]

"""`mesh_inpaint_processor.meshVerticeInpaint`, in numpy.

The paint stage bakes six views into a UV texture, and whatever no view saw is
left empty. Before OpenCV's image inpainting fills those holes, the original
spreads colour along the mesh itself: every vertex whose UV texel is unseen
takes the distance-weighted mean of its coloured one-ring neighbours, repeated
until nothing more can be reached. That puts the right colour on the far side
of a seam, which image-space inpainting cannot know about.

The original is a pybind11 extension that has to be compiled. This is the same
algorithm on a sparse adjacency matrix. One deliberate difference: the C++
updates vertices in place, one after another (Gauss-Seidel), so a pass can
carry colour several rings at once; here a pass reads the previous pass's
colours (Jacobi). It needs more passes to reach the same vertices and lands on
the same colours to within smoothing, and it is a few array operations instead
of a Python loop over a million vertices.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse


def _uv_texels(
    vtx_uv: np.ndarray, uv_idx: np.ndarray, height: int, width: int
) -> tuple[np.ndarray, np.ndarray]:
    uv = vtx_uv[uv_idx.reshape(-1)]
    col = np.rint(uv[:, 0] * (width - 1)).astype(np.int64)
    row = np.rint((1.0 - uv[:, 1]) * (height - 1)).astype(np.int64)
    return np.clip(row, 0, height - 1), np.clip(col, 0, width - 1)


def meshVerticeInpaint(  # noqa: N802 - the extension's own name, which the vendored code imports
    texture: np.ndarray,
    mask: np.ndarray,
    vtx_pos: np.ndarray,
    vtx_uv: np.ndarray,
    pos_idx: np.ndarray,
    uv_idx: np.ndarray,
    method: str = "smooth",
) -> tuple[np.ndarray, np.ndarray]:
    if method != "smooth":
        raise ValueError("only the 'smooth' method is implemented")

    texture = np.asarray(texture, dtype=np.float32)
    mask = np.asarray(mask, dtype=np.uint8)
    height, width, channels = texture.shape
    vtx_pos = np.asarray(vtx_pos, dtype=np.float32)
    pos_idx = np.asarray(pos_idx, dtype=np.int64)
    uv_idx = np.asarray(uv_idx, dtype=np.int64)
    count = vtx_pos.shape[0]

    rows, cols = _uv_texels(np.asarray(vtx_uv, dtype=np.float32), uv_idx, height, width)
    corner_vtx = pos_idx.reshape(-1)
    seen = mask[rows, cols] > 0

    colored = np.zeros(count, dtype=bool)
    color = np.zeros((count, channels), dtype=np.float32)
    # Last write wins, as in the C++ loop over face corners.
    colored[corner_vtx[seen]] = True
    color[corner_vtx[seen]] = texture[rows[seen], cols[seen]]
    uncolored = np.unique(corner_vtx[~seen])

    # Directed one-ring edges v_k -> v_{k+1} per face, summed where repeated,
    # weighted by inverse squared distance as `calculateDistanceWeight` does.
    src = pos_idx.reshape(-1)
    dst = np.roll(pos_idx, -1, axis=1).reshape(-1)
    dist = np.linalg.norm(vtx_pos[src] - vtx_pos[dst], axis=1)
    weight = (1.0 / np.maximum(dist, 1e-4)) ** 2
    graph = sparse.csr_matrix((weight, (src, dst)), shape=(count, count))
    graph_u = graph[uncolored]

    # The extension's stopping rule: carry on while the number of unreachable
    # vertices keeps changing, then for as many quiet passes as it changed.
    smooth_count = 2
    last_uncolored = 0
    while smooth_count > 0:
        known = colored.astype(np.float32)
        total = graph_u @ known
        summed = graph_u @ (color * known[:, None])
        reach = total > 0
        hit = uncolored[reach]
        color[hit] = summed[reach] / total[reach, None]
        colored[hit] = True
        unreached = int((~reach).sum())
        if unreached == last_uncolored:
            smooth_count -= 1
        else:
            smooth_count += 1
        last_uncolored = unreached

    new_texture = texture.copy()
    new_mask = mask.copy()
    write = colored[corner_vtx]
    new_texture[rows[write], cols[write]] = color[corner_vtx[write]]
    new_mask[rows[write], cols[write]] = 255
    return new_texture.reshape(height, width, channels)[..., :3], new_mask.reshape(height, width)

"""Skin weights cleaned up before they are bound.

The weight network predicts each vertex on its own, from where it is and which
way it faces, and what comes back tears a mesh once it moves in three ways:

- Split seams. An image-to-3D mesh splits its vertices along UV seams; each
  half is predicted on its own and the two may disagree, so the seam opens.
- Outliers. Now and then a vertex is owned by a bone none of its neighbours
  follow, and is dragged off with it.
- Fingers. With the finger bones folded into the hand, the network still
  weights the fingers as fingers, often well into the forearm, a whole
  fingertip at a time. Once the elbow bends in a wave, the fingers smear.

`clean` handles the first two over the mesh's own connectivity -- its edges,
and vertices on the same spot -- never over plain distance, which would blend
a hand into the thigh it hangs beside. `rigid_hands` handles the third, once
the joints are known.
"""

from __future__ import annotations

import numpy as np

#: An L1 distance from the neighbours' mean above which a vertex is an outlier.
OUTLIER = 0.5
OUTLIER_ROUNDS = 4
#: Rounds of smoothing for a mesh read through its shell (`surface`), whose
#: weights come back with steps between neighbours that a closed mesh's do not
#: have. On a closed mesh the same smoothing makes a run cycle worse.
SMOOTH_ROUNDS = 3
SMOOTH_STEP = 0.5
#: How far past the wrist, as a share of the forearm, the hand takes over whole.
HAND_RAMP = 0.3
#: The share of a vertex an arm's chain must hold for it to count as that arm's.
ARM_CHAIN = 0.8


def _normalised(weights: np.ndarray) -> np.ndarray:
    total = weights.sum(axis=1, keepdims=True)
    total[total == 0] = 1.0
    return weights / total


def coincident(vertices: np.ndarray) -> np.ndarray:
    """A group index per vertex; vertices on the same spot share one."""
    extent = float(np.ptp(vertices, axis=0).max()) or 1.0
    keys = np.round(np.asarray(vertices, dtype=np.float64) / (extent * 1e-6)).astype(np.int64)
    return np.unique(keys, axis=0, return_inverse=True)[1].ravel()


def neighbour_mean(faces: np.ndarray, groups: np.ndarray):  # -> scipy.sparse.csr_matrix
    """Row-normalised adjacency between vertex groups, over the faces' edges."""
    # Here rather than at the top: blend.py imports this module before bpy.
    from scipy import sparse

    n = int(groups.max()) + 1
    edges = groups[np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])]
    edges = edges[edges[:, 0] != edges[:, 1]]
    rows = np.concatenate([edges[:, 0], edges[:, 1]])
    cols = np.concatenate([edges[:, 1], edges[:, 0]])
    graph = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))
    graph.data[:] = 1.0
    degree = np.asarray(graph.sum(axis=1)).ravel()
    degree[degree == 0] = 1.0
    return sparse.diags(1.0 / degree) @ graph


def clean(bw: np.ndarray, vertices: np.ndarray, faces: np.ndarray, smooth: int = 0) -> np.ndarray:
    """`bw` (vertices x bones) with seams closed and outliers replaced, rows summing to 1."""
    groups = coincident(vertices)
    count = np.bincount(groups).astype(np.float64)
    weights = np.zeros((len(count), bw.shape[1]))
    np.add.at(weights, groups, np.asarray(bw, dtype=np.float64))
    weights /= count[:, None]

    mean_of = neighbour_mean(np.asarray(faces), groups)
    connected = np.asarray(mean_of.sum(axis=1)).ravel() > 0
    for _ in range(OUTLIER_ROUNDS):
        around = mean_of @ weights
        outliers = (np.abs(weights - around).sum(axis=1) > OUTLIER) & connected
        if not outliers.any():
            break
        weights[outliers] = around[outliers]
    for _ in range(smooth):
        around = mean_of @ weights
        weights[connected] += SMOOTH_STEP * (around[connected] - weights[connected])
    return _normalised(weights)[groups].astype(np.asarray(bw).dtype)


def rigid_hands(
    bw: np.ndarray, vertices: np.ndarray, joints: np.ndarray, bones_idx_dict: dict[str, int]
) -> np.ndarray:
    """Past the wrist, a hand without finger bones moves as one piece.

    Along the forearm's axis, a vertex of the arm past the wrist goes over to
    the hand, in full by `HAND_RAMP` of a forearm's length. A hand that kept
    its finger bones is left to them.
    """
    weights = np.asarray(bw, dtype=np.float64).copy()
    for side in ("Left", "Right"):
        bone = {part: bones_idx_dict.get(f"mixamorig:{side}{part}") for part in ("Arm", "ForeArm", "Hand")}
        if None in bone.values() or f"mixamorig:{side}HandIndex1" in bones_idx_dict:
            continue
        wrist, elbow = joints[bone["Hand"]], joints[bone["ForeArm"]]
        length = float(np.linalg.norm(wrist - elbow))
        if length == 0:
            continue
        past = (vertices - wrist) @ ((wrist - elbow) / length)
        chain = weights[:, list(bone.values())].sum(axis=1)
        share = np.clip(past / (HAND_RAMP * length), 0.0, 1.0) * (chain >= ARM_CHAIN)
        weights *= 1.0 - share[:, None]
        weights[:, bone["Hand"]] += share
    return _normalised(weights).astype(np.asarray(bw).dtype)

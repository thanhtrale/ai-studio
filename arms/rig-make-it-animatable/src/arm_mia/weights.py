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
#: How much further than its nearest bone, as a share of the character's
#: height, a bone may be and still hold weight on a vertex: about 22 cm on a
#: 1.8 m character. Further is the network spilling weight across the body.
FAR = 0.12


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


def bone_distances(vertices: np.ndarray, heads: np.ndarray, tails: np.ndarray) -> np.ndarray:
    """(vertices x bones): each vertex's distance to each bone, as a segment head to tail."""
    vertices = np.asarray(vertices, dtype=np.float64)
    out = np.empty((len(vertices), len(heads)))
    heads, tails = np.asarray(heads, np.float64), np.asarray(tails, np.float64)
    for index, (head, tail) in enumerate(zip(heads, tails, strict=True)):
        along = tail - head
        length2 = float(along @ along)
        t = np.zeros(len(vertices)) if length2 == 0 else (vertices - head) @ along / length2
        t = np.clip(t, 0.0, 1.0)
        out[:, index] = np.linalg.norm(vertices - (head + t[:, None] * along), axis=1)
    return out


def prune_far(bw: np.ndarray, vertices: np.ndarray, heads: np.ndarray, tails: np.ndarray) -> np.ndarray:
    """`bw` with the weight a vertex puts on bones nowhere near it taken away.

    The network now and then spills weight across the body -- a fist holding a
    fifth of itself on Head and a little on a thigh -- and such a vertex goes
    wherever the far bone goes. A bone counts as far when it is `FAR` of the
    character's height further from the vertex than the vertex's nearest bone.
    A vertex whose every weight is far keeps them all: there is nothing better.
    """
    weights = np.asarray(bw, dtype=np.float64)
    vertices = np.asarray(vertices, dtype=np.float64)
    height = float(np.ptp(vertices[:, 1])) or 1.0
    distance = bone_distances(vertices, heads, tails)
    near = distance <= distance.min(axis=1, keepdims=True) + FAR * height
    kept = np.where(near, weights, 0.0)
    empty = kept.sum(axis=1) <= 0
    kept[empty] = weights[empty]
    return _normalised(kept).astype(np.asarray(bw).dtype)


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


#: Sleeves: where, beyond the shoulder joint, a vertex starts and ends going over to the arm, as shares of
#: the character's height. The start leaves hair hanging close beside the shoulders to the body.
SLEEVE_START = 0.02
SLEEVE_FULL = 0.07
#: How far in front of or behind the shoulder a sleeve reaches; hair down the back is further.
SLEEVE_DEPTH = 0.12


def rigid_sleeves(
    bw: np.ndarray,
    vertices: np.ndarray,
    joints: np.ndarray,
    tails: np.ndarray,
    bones_idx_dict: dict[str, int],
) -> np.ndarray:
    """In a T-pose, everything out past a shoulder and above the hips is that arm's.

    A wide sleeve hangs from the arm down beside the waist, and the network
    weights its lower half to the spine it is near. Once the arm comes down
    the sleeve is pulled two ways and tears into shards. Moved over to the
    nearest bone of the arm's chain, it swings with the arm instead (and may
    pass through the body, which a game hides far better than a tear).
    """
    weights = np.asarray(bw, dtype=np.float64).copy()
    vertices = np.asarray(vertices, dtype=np.float64)
    height = float(np.ptp(vertices[:, 1])) or 1.0
    hips = bones_idx_dict.get("mixamorig:Hips")
    if hips is None:
        return np.asarray(bw)
    distance = bone_distances(vertices, joints, tails)
    for side in ("Left", "Right"):
        chain = [
            bones_idx_dict.get(f"mixamorig:{side}{part}") for part in ("Shoulder", "Arm", "ForeArm", "Hand")
        ]
        chain = [index for index in chain if index is not None]
        arm = bones_idx_dict.get(f"mixamorig:{side}Arm")
        if arm is None:
            continue
        shoulder = joints[arm]
        outward = np.sign(shoulder[0] - joints[hips][0]) or 1.0
        lateral = (vertices[:, 0] - shoulder[0]) * outward
        share = np.clip((lateral - SLEEVE_START * height) / ((SLEEVE_FULL - SLEEVE_START) * height), 0.0, 1.0)
        share *= (vertices[:, 1] > joints[hips][1]) & (
            np.abs(vertices[:, 2] - shoulder[2]) < SLEEVE_DEPTH * height
        )
        if not share.any():
            continue
        nearest = np.asarray(chain)[distance[:, chain].argmin(axis=1)]
        off_chain = np.ones(weights.shape[1], dtype=bool)
        off_chain[chain] = False
        moved = weights[:, off_chain].sum(axis=1) * share
        weights[:, off_chain] *= (1.0 - share)[:, None]
        weights[np.arange(len(weights)), nearest] += moved
    return _normalised(weights).astype(np.asarray(bw).dtype)

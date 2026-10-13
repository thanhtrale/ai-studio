"""The hips frame MIA reads a character in, kept upright.

MIA moves a character into its hips frame before the fine networks see it:
origin at the coarse Hips joint, forward along the normal of the plane through
Hips and the two UpLeg joints, x from the right UpLeg to the left. Those three
points are a few centimetres apart, so a coarse joint a little off tilts the
whole frame -- on a TRELLIS.2 character standing straight in a T-pose, by
about 13 degrees about the view axis.

Hips is never posed (`pose_ignore`), so the tilt cannot be undone where it
belongs. The pose network takes it out of the bones above and below instead:
the spine bent 19 degrees, the thighs 23, the arms 40 -- and once that pose is
made the rest, the body comes out twisted at the waist.

Every mesh this arm is given comes from an image-to-3D model and stands
y-up, so only the frame's heading is worth taking from the joints. `level`
keeps that and drops the roll and pitch.
"""

from __future__ import annotations

import numpy as np

UP = np.array([0.0, 1.0, 0.0])


def level(hips: np.ndarray, right: np.ndarray, left: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Two UpLeg points that give the same heading on a level, upright frame.

    Each argument is (..., 3). The points come back symmetric about Hips, at
    the same depth below it, along the horizontal part of right-to-left -- so
    the plane through them is vertical and its normal horizontal. None when
    the joints are too degenerate to have a heading: the caller keeps its own.
    """
    across = left - right
    across = across - (across @ UP)[..., None] * UP
    width = np.linalg.norm(across, axis=-1, keepdims=True)
    drop = hips[..., 1:2] - 0.5 * (right[..., 1:2] + left[..., 1:2])
    if np.any(width < 1e-6) or np.any(drop <= 0):
        return None
    half = 0.5 * across
    below = -drop * UP
    return hips - half + below, hips + half + below


def swing(direction: np.ndarray, target: np.ndarray) -> np.ndarray:
    """The smallest rotation taking unit `direction` to unit `target`, as a 3x3 matrix."""
    axis = np.cross(direction, target)
    sin = float(np.linalg.norm(axis))
    cos = float(np.clip(direction @ target, -1.0, 1.0))
    if sin < 1e-9:
        if cos > 0:
            return np.eye(3)
        # Half a turn: about any axis square to the bone.
        other = np.array([1.0, 0.0, 0.0]) if abs(direction[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        axis = np.cross(direction, other)
        axis /= np.linalg.norm(axis)
        return 2.0 * np.outer(axis, axis) - np.eye(3)
    axis /= sin
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + sin * skew + (1.0 - cos) * skew @ skew


def untwist(pose: np.ndarray, joints: np.ndarray, tails: np.ndarray) -> np.ndarray:
    """The T-pose with every bone's twist about its own axis taken out.

    `pose` is MIA's, one 4x4 per bone in the joints' frame, taking the mesh as
    it stands to a T-pose. On a generated character most of what it says
    about the limbs is twist: an upper arm turned 50 degrees of which 17 point
    it somewhere new, a thigh 21 of which 3. Nothing in a fused, image-made
    mesh says which way an arm is turned, and made the rest, the twist wrings
    the limbs between neighbouring bones. Each bone keeps where it points and
    where its head goes; the turn about its length is dropped, which leaves
    the template's roll -- Mixamo's, the one the clips are authored against.
    """
    out = np.array(pose, dtype=np.float64, copy=True)
    for index in range(len(out)):
        direction = tails[index] - joints[index]
        length = float(np.linalg.norm(direction))
        if length < 1e-9:
            continue
        direction = direction / length
        rotation = out[index, :3, :3]
        target = rotation @ direction
        target /= np.linalg.norm(target)
        head = rotation @ joints[index] + out[index, :3, 3]
        kept = swing(direction, target)
        out[index, :3, :3] = kept
        out[index, :3, 3] = head - kept @ joints[index]
    return out.astype(np.asarray(pose).dtype)


def upright(original):
    """`get_hips_transform` with the UpLeg joints levelled first; same signature, torch in and out."""

    def transform(hips, rightupleg, leftupleg):
        import torch

        levelled = level(
            hips.detach().cpu().double().numpy(),
            rightupleg.detach().cpu().double().numpy(),
            leftupleg.detach().cpu().double().numpy(),
        )
        if levelled is None:
            return original(hips, rightupleg, leftupleg)
        right, left = (torch.from_numpy(points).to(hips) for points in levelled)
        return original(hips, right, left)

    return transform

import numpy as np
import pytest

pytest.importorskip("scipy")

from arm_mia import weights


def strip(n: int):
    """A row of quads along x, every vertex doubled as if split along a seam."""
    xs = np.arange(n, dtype=np.float64)
    vertices = np.concatenate(
        [np.stack([xs, np.zeros(n), np.zeros(n)], 1), np.stack([xs, np.ones(n), np.zeros(n)], 1)]
    )
    faces = []
    for i in range(n - 1):
        a, b, c, d = i, i + 1, n + i, n + i + 1
        faces += [[a, b, c], [b, d, c]]
    faces = np.array(faces)
    seam = vertices.copy()
    return np.concatenate([vertices, seam]), np.concatenate([faces, faces + len(vertices)])


def test_seams_close_and_outliers_follow_their_neighbours():
    vertices, faces = strip(8)
    half = len(vertices) // 2
    bw = np.tile([1.0, 0.0], (len(vertices), 1))
    bw[3] = [0.0, 1.0]  # an outlier, on one side of the seam only
    bw[half + 5] = [0.4, 0.6]  # the seam's halves disagree
    out = weights.clean(bw, vertices, faces)
    np.testing.assert_allclose(out[:half], out[half:])
    assert out[3, 0] > 0.9


def test_fingers_go_over_to_the_hand_past_the_wrist():
    bones = {"mixamorig:RightArm": 0, "mixamorig:RightForeArm": 1, "mixamorig:RightHand": 2}
    joints = np.array([[0.0, 0, 0], [-0.25, 0, 0], [-0.5, 0, 0]])
    vertices = np.array([[-0.2, 0, 0], [-0.52, 0, 0], [-0.65, 0, 0]])
    bw = np.array([[0.3, 0.7, 0.0], [0.1, 0.5, 0.4], [0.1, 0.5, 0.4]])
    out = weights.rigid_hands(bw, vertices, joints, bones)
    np.testing.assert_allclose(out[0], bw[0])  # before the wrist: untouched
    assert 0.4 < out[1, 2] < 1.0  # just past it: partly over
    np.testing.assert_allclose(out[2], [0, 0, 1], atol=1e-6)  # a hand's length out: all hand


def test_hands_with_finger_bones_are_left_alone():
    bones = {
        "mixamorig:RightArm": 0,
        "mixamorig:RightForeArm": 1,
        "mixamorig:RightHand": 2,
        "mixamorig:RightHandIndex1": 3,
    }
    joints = np.array([[0.0, 0, 0], [-0.25, 0, 0], [-0.5, 0, 0], [-0.6, 0, 0]])
    bw = np.array([[0.0, 0.2, 0.3, 0.5]])
    out = weights.rigid_hands(bw, np.array([[-0.65, 0, 0]]), joints, bones)
    np.testing.assert_allclose(out, bw)


def test_smoothing_evens_out_a_step_between_neighbours():
    vertices, faces = strip(8)
    bw = np.tile([1.0, 0.0], (len(vertices), 1))
    step = vertices[:, 0] >= 4
    bw[step] = [0.6, 0.4]
    out = weights.clean(bw, vertices, faces, smooth=3)
    jump = lambda w: np.abs(np.diff(w[:8, 1])).max()  # noqa: E731
    assert jump(out) < jump(bw) / 2
    np.testing.assert_allclose(out.sum(axis=1), 1.0)


def test_weight_on_a_bone_across_the_body_is_taken_away():
    # A hand out to the side, a head above the spine; one vertex in the hand
    # holding a fifth of itself on the head, as the network sometimes leaves it.
    heads = np.array([[0.6, 0.6, 0.0], [0.0, 0.7, 0.0], [0.0, -0.9, 0.0]])
    tails = np.array([[0.7, 0.6, 0.0], [0.0, 0.9, 0.0], [0.0, 0.7, 0.0]])
    vertices = np.array(
        [[0.65, 0.62, 0.0], [0.0, 0.8, 0.05], [0.05, 0.7, 0.0], [0.0, -1.0, 0.0], [0.0, 1.0, 0.0]]
    )
    bw = np.array([[0.8, 0.2, 0.0], [0.1, 0.9, 0.0], [0.0, 0.3, 0.7], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])

    out = weights.prune_far(bw, vertices, heads, tails)

    assert np.allclose(out[0], [1.0, 0.0, 0.0])
    assert np.allclose(out[1], [0.0, 1.0, 0.0])
    # Head and spine meet at the neck: a vertex near both keeps both.
    assert out[2, 1] > 0
    assert np.allclose(out.sum(axis=1), 1)


def test_a_hanging_sleeve_goes_over_to_the_arm_and_the_body_and_back_hair_stay():
    bones = {"mixamorig:Hips": 0, "mixamorig:Spine": 1, "mixamorig:LeftArm": 2, "mixamorig:LeftForeArm": 3}
    joints = np.array([[0.0, 1.0, 0.0], [0.0, 1.2, 0.0], [0.2, 1.5, 0.0], [0.45, 1.5, 0.0]])
    tails = np.array([[0.0, 1.2, 0.0], [0.0, 1.5, 0.0], [0.45, 1.5, 0.0], [0.7, 1.5, 0.0]])
    vertices = np.array(
        [
            [0.4, 1.15, 0.0],  # sleeve hanging beside the waist
            [0.05, 1.3, 0.0],  # chest
            [0.4, 1.3, -0.4],  # hair far down the back
            [0.4, 0.5, 0.0],  # robe hem below the hips
            [0.0, 0.0, 0.0],  # feet, for the height
        ]
    )
    bw = np.array(
        [[0.2, 0.6, 0.1, 0.1], [0.1, 0.9, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [1.0, 0, 0, 0], [1.0, 0, 0, 0]]
    )
    out = weights.rigid_sleeves(bw, vertices, joints, tails, bones)
    assert out[0, :2].sum() == pytest.approx(0.0)  # nothing left on the hips and spine
    assert out[0, 2] == pytest.approx(0.9)  # the hips' and spine's share went to the nearest arm bone
    np.testing.assert_allclose(out[1:], bw[1:])

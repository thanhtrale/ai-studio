import numpy as np

from arm_mia import frame


def rotation(axis, degrees):
    axis = np.asarray(axis, dtype=np.float64)
    axis /= np.linalg.norm(axis)
    angle = np.radians(degrees)
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * skew + (1 - np.cos(angle)) * skew @ skew


def test_level_keeps_the_heading_and_drops_the_roll():
    hips = np.array([[0.0, 0.0, 0.0]])
    # Rolled 13 degrees about the view axis and turned 20 about the vertical.
    turn = rotation([0, 1, 0], 20) @ rotation([0, 0, 1], 13)
    right = (turn @ np.array([-0.1, -0.05, 0.0]))[None]
    left = (turn @ np.array([0.1, -0.05, 0.0]))[None]

    new_right, new_left = frame.level(hips, right, left)

    assert np.isclose(new_right[0, 1], new_left[0, 1])
    assert new_right[0, 1] < 0
    across = new_left[0] - new_right[0]
    assert np.isclose(across[1], 0)
    heading = np.arctan2(-across[2], across[0])
    assert np.isclose(np.degrees(heading), 20, atol=1e-6)


def test_level_gives_up_on_joints_with_no_heading():
    hips = np.zeros((1, 3))
    assert frame.level(hips, np.array([[0.0, -0.1, 0.0]]), np.array([[0.0, -0.1, 0.0]])) is None
    # UpLegs above the hips: not a body the frame can be read from.
    assert frame.level(hips, np.array([[-0.1, 0.1, 0.0]]), np.array([[0.1, 0.1, 0.0]])) is None


def test_swing_turns_one_direction_onto_another_and_nothing_else():
    for target in ([0, 1, 0], [0.6, 0.8, 0], [-1, 0, 0], [1, 0, 0]):
        target = np.asarray(target, dtype=np.float64)
        matrix = frame.swing(np.array([1.0, 0.0, 0.0]), target)
        assert np.allclose(matrix @ [1, 0, 0], target)
        assert np.allclose(matrix @ matrix.T, np.eye(3))
        assert np.isclose(np.linalg.det(matrix), 1)


def test_untwist_keeps_where_a_bone_points_and_drops_its_turn():
    joints = np.array([[0.1, 0.5, 0.0]])
    tails = np.array([[0.4, 0.5, 0.0]])
    # A real 15 degree swing down, and 50 degrees of twist about the arm.
    turn = rotation([0, 0, 1], -15) @ rotation([1, 0, 0], 50)
    pose = np.eye(4)[None].repeat(1, 0)
    pose[0, :3, :3] = turn
    pose[0, :3, 3] = [0.02, 0.0, 0.0]

    out = frame.untwist(pose, joints, tails)

    direction = np.array([1.0, 0.0, 0.0])
    assert np.allclose(out[0, :3, :3] @ direction, turn @ direction)
    angle = np.degrees(np.arccos((np.trace(out[0, :3, :3]) - 1) / 2))
    assert np.isclose(angle, 15)
    head = lambda m: m[:3, :3] @ joints[0] + m[:3, 3]  # noqa: E731
    assert np.allclose(head(out[0]), head(pose[0]))

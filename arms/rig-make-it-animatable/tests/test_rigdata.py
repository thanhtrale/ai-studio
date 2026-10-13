import json
from types import SimpleNamespace

import numpy as np
import pytest

from arm_mia import rigdata


class FakeMesh(SimpleNamespace):
    def export(self, path):
        path.write_bytes(b"glb")

    def copy(self):
        return self


def rig(remove_fingers=True):
    """Hips -> LeftArm -> LeftHand -> LeftHandIndex1, along +x, three vertices."""
    names = ["mixamorig:Hips", "mixamorig:LeftArm", "mixamorig:LeftHand", "mixamorig:LeftHandIndex1"]
    joints = np.array([[0, 0, 0], [0.2, 0.5, 0], [0.6, 0.5, 0], [0.7, 0.5, 0]], dtype=np.float32)
    tails = np.array([[0, 0.3, 0], [0.6, 0.5, 0], [0.7, 0.5, 0], [0.8, 0.5, 0]], dtype=np.float32)
    bw = np.array([[1, 0, 0, 0], [0, 0.7, 0.3, 0], [0, 0, 0.4, 0.6]], dtype=np.float32)
    return {
        "mesh": FakeMesh(
            vertices=np.array([[0, 0, 0], [0.4, 0.5, 0], [0.75, 0.5, 0]]), faces=np.array([[0, 1, 2]])
        ),
        "joints": joints,
        "joints_tail": tails,
        "bw": bw,
        "pose": np.repeat(np.eye(4, dtype=np.float32)[None], 4, axis=0),
        "bones_idx_dict": {name: i for i, name in enumerate(names)},
        "parents": np.array([-1, 0, 1, 2]),
        "options": json.dumps({"remove_fingers": remove_fingers, "inplace": True, "pose_ignore": ["Hips"]}),
    }


def test_folding_moves_finger_weight_into_the_hand_and_keeps_parents_straight():
    out = rigdata.fold_fingers(rig())
    assert list(out["bones_idx_dict"]) == ["mixamorig:Hips", "mixamorig:LeftArm", "mixamorig:LeftHand"]
    assert np.allclose(out["bw"][2], [0, 0, 1.0])
    assert out["parents"].tolist() == [-1, 0, 1]
    assert out["joints"].shape == (3, 3)


def test_finalise_is_done_once_and_keeps_where_the_tpose_points_each_bone():
    once = rigdata.finalise(rig())
    assert rigdata.options_of(once)["prepared"] is True
    assert np.allclose(once["targets"][1], [1, 0, 0])
    assert rigdata.finalise(once) is once


def test_four_influences_round_trip_through_the_draft_layout():
    rng = np.random.default_rng(0)
    bw = rng.random((50, 7))
    indices, values = rigdata.top_influences(bw)
    assert indices.shape == (50, 4) and values.dtype == np.float32
    assert np.allclose(values.sum(axis=1), 1)
    blob = rigdata.encode_weights(indices, values)
    assert len(blob) == 50 * 4 * 5
    back_indices, back_values = rigdata.decode_weights(blob, 50, 7)
    assert np.array_equal(back_indices, indices)
    dense = rigdata.dense_from_top(back_indices, back_values, 7)
    assert np.allclose(dense.sum(axis=1), 1)
    # The strongest bone survives as the strongest.
    assert np.array_equal(dense.argmax(axis=1), bw.argmax(axis=1))


def test_fewer_than_four_bones_still_fill_four_slots():
    indices, values = rigdata.top_influences(np.array([[0.2, 0.8]]))
    assert indices.shape == (1, 4)
    assert np.allclose(values[0], [0.8, 0.2, 0, 0])


@pytest.mark.parametrize(
    ("blob", "message"),
    [
        (b"\x00" * 7, "bytes"),
        (np.full(12, -1, "<f4").tobytes() + bytes(12), "not negative"),
        (np.full(12, 0.25, "<f4").tobytes() + bytes([9] * 12), "past the"),
    ],
)
def test_bad_edited_weights_are_refused(blob, message):
    with pytest.raises(rigdata.EditError, match=message):
        rigdata.decode_weights(blob, 3, 4)


def test_a_moved_bone_is_posed_from_where_it_now_points():
    data = rigdata.finalise(rig())
    # The T-pose points LeftArm along +x; move its tail so it droops 45 degrees.
    edits = {"mixamorig:LeftArm": {"head": [0.2, 0.5, 0.0], "tail": [0.5, 0.2, 0.0]}}
    out = rigdata.apply_edits(data, edits, None)
    index = out["bones_idx_dict"]["mixamorig:LeftArm"]
    assert np.allclose(out["joints_tail"][index], [0.5, 0.2, 0])
    rotation = out["pose"][index][:3, :3]
    direction = np.array([0.3, -0.3, 0]) / np.linalg.norm([0.3, -0.3, 0])
    assert np.allclose(rotation @ direction, [1, 0, 0], atol=1e-6)


def test_repainted_weights_replace_the_predicted_ones():
    data = rigdata.finalise(rig())
    bones = len(data["bones_idx_dict"])
    indices = np.zeros((3, 4), np.uint8)
    indices[:, 0] = [0, 1, 1]
    values = np.zeros((3, 4), np.float32)
    values[:, 0] = 1
    out = rigdata.apply_edits(data, None, rigdata.encode_weights(indices, values))
    assert out["bw"].shape == (3, bones)
    assert np.allclose(out["bw"][2], [0, 1, 0])


@pytest.mark.parametrize(
    ("edits", "message"),
    [
        ({"mixamorig:Nope": {"head": [0, 0, 0], "tail": [0, 1, 0]}}, "not a bone"),
        ({"mixamorig:Hips": {"head": [0, 0], "tail": [0, 1, 0]}}, "three numbers"),
        ({"mixamorig:Hips": {"head": [0, 0, 99], "tail": [0, 1, 0]}}, "out of range"),
        ({"mixamorig:Hips": {"head": [0, 0, 0], "tail": [0, 0, 0]}}, "same spot"),
        ({"mixamorig:Hips": "up"}, "head and a tail"),
    ],
)
def test_bad_bone_edits_are_refused_by_name(edits, message):
    with pytest.raises(rigdata.EditError, match=message):
        rigdata.apply_edits(rigdata.finalise(rig()), edits, None)


def test_a_draft_written_and_read_back_is_the_same_rig(tmp_path):
    data = rigdata.finalise(rig())
    described = rigdata.write_draft(tmp_path / "d", data)
    assert {p.name for p in (tmp_path / "d").iterdir()} == {"rig.npz", "mesh.glb", "weights.bin", "rig.json"}
    assert described["vertexCount"] == 3
    assert [bone["name"] for bone in described["bones"]] == list(data["bones_idx_dict"])
    assert [bone["parent"] for bone in described["bones"]] == [-1, 0, 1]
    assert json.loads((tmp_path / "d" / "rig.json").read_text())["removeFingers"] is True

    back = rigdata.load(tmp_path / "d" / "rig.npz")
    assert np.allclose(back["joints"], data["joints"])
    assert back["bones_idx_dict"] == data["bones_idx_dict"]
    assert np.allclose(back["targets"], data["targets"])
    assert rigdata.options_of(back)["prepared"] is True

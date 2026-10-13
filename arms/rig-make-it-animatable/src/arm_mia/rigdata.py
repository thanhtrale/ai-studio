"""A predicted rig as data: folded, finalised, written out for review, and edited back in.

A rig is a dict of arrays -- the shape `engine.predict` returns and `blend.py`
reads from an `.npz`:

- `mesh`: the trimesh mesh, in MIA's frame (y-up, hips at the origin)
- `joints`, `joints_tail`: one head and one tail per bone
- `bw`: per-vertex skin weights, vertices x bones
- `pose`: per-bone 4x4 transforms that take the mesh to a T-pose, or None
- `bones_idx_dict`: bone name -> column of `bw`
- `parents`: each bone's parent's index, -1 for the root
- `options`: JSON -- `remove_fingers`, `inplace`, `pose_ignore`, `prepared`

`finalise` does here what `blend.py` used to do on its own -- fold the fingers
into the hands, make the hands rigid -- so that what a person reviews is what
Blender binds. It also keeps, per bone, the direction the T-pose points it in,
which is what lets a bone that has been moved still be posed: its rotation is
rebuilt from where it now points to where the T-pose wants it.

A draft on disk, for the studio's rig editor:

- `rig.npz`: the finalised rig
- `mesh.glb`: the mesh in the same frame and vertex order
- `rig.json`: bones (name, parent, head, tail) and counts
- `weights.bin`: the four strongest influences per vertex -- vertexCount x 4
  float32 weights, then vertexCount x 4 uint8 bone indices. Four, because the
  GLB is exported with four influences per vertex and nothing past them
  survives anyway.

An edited draft adds `weights.edited.bin`, the same layout, written by the
studio; edited bones arrive with the bind job itself.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from . import frame, weights

INFLUENCES = 4
FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
#: How far a coordinate may be from the origin in MIA's frame, where a body is
#: about two units tall. Anything further is a typo, not an edit.
MAX_COORDINATE = 10.0


class EditError(ValueError):
    """An edit that does not fit the draft it is for."""


def is_finger(bone_name: str) -> bool:
    return any(finger in bone_name for finger in FINGERS)


def names_of(data: dict[str, Any]) -> list[str]:
    names: list[str] = [""] * len(data["bones_idx_dict"])
    for name, index in data["bones_idx_dict"].items():
        names[index] = name
    return names


def options_of(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("options", "{}")
    return json.loads(str(raw)) if not isinstance(raw, dict) else dict(raw)


def fold_fingers(data: dict[str, Any]) -> dict[str, Any]:
    """Fold every finger into its hand: a generated mesh's fingers are fused anyway."""
    names = names_of(data)
    keep = [i for i, name in enumerate(names) if not is_finger(name)]

    bw = np.asarray(data["bw"]).copy()
    for i, name in enumerate(names):
        if is_finger(name):
            hand = "Left" if "Left" in name else "Right"
            bw[:, data["bones_idx_dict"][f"mixamorig:{hand}Hand"]] += bw[:, i]

    out = dict(data)
    out["joints"] = np.asarray(data["joints"])[keep]
    out["joints_tail"] = np.asarray(data["joints_tail"])[keep]
    out["bw"] = bw[:, keep]
    if data.get("pose") is not None:
        out["pose"] = np.asarray(data["pose"])[keep]
    out["bones_idx_dict"] = {names[i]: j for j, i in enumerate(keep)}
    if data.get("parents") is not None:
        position = {old: new for new, old in enumerate(keep)}
        parents = np.asarray(data["parents"])
        out["parents"] = np.array([position.get(int(parents[i]), -1) for i in keep], dtype=np.int64)
    return out


def tpose_directions(pose: np.ndarray | None, joints: np.ndarray, tails: np.ndarray) -> np.ndarray | None:
    """Per bone, the unit direction the T-pose points it in."""
    if pose is None:
        return None
    directions = np.asarray(tails, np.float64) - np.asarray(joints, np.float64)
    out = np.einsum("kij,kj->ki", np.asarray(pose, np.float64)[:, :3, :3], directions)
    lengths = np.linalg.norm(out, axis=1, keepdims=True)
    lengths[lengths == 0] = 1.0
    return out / lengths


def finalise(data: dict[str, Any]) -> dict[str, Any]:
    """The rig as Blender will bind it: fingers folded if asked, hands rigid, T-pose directions kept."""
    options = options_of(data)
    if options.get("prepared"):
        return data
    out = fold_fingers(data) if options.get("remove_fingers") else dict(data)
    vertices = np.asarray(out["mesh"].vertices)
    out["bw"] = weights.rigid_hands(out["bw"], vertices, out["joints"], out["bones_idx_dict"])
    pose = out.get("pose")
    out["targets"] = tpose_directions(pose, out["joints"], out["joints_tail"])
    out["options"] = json.dumps({**options, "prepared": True})
    return out


def pose_from_targets(targets: np.ndarray, joints: np.ndarray, tails: np.ndarray) -> np.ndarray:
    """A swing-only T-pose that points each bone, from where it is now, along its target."""
    pose = np.repeat(np.eye(4)[None], len(joints), axis=0)
    for index, (head, tail, target) in enumerate(zip(joints, tails, targets, strict=True)):
        direction = np.asarray(tail, np.float64) - np.asarray(head, np.float64)
        length = float(np.linalg.norm(direction))
        if length < 1e-9 or not np.all(np.isfinite(target)):
            continue
        rotation = frame.swing(direction / length, np.asarray(target, np.float64))
        pose[index, :3, :3] = rotation
        pose[index, :3, 3] = head - rotation @ head
    return pose


def top_influences(bw: np.ndarray, count: int = INFLUENCES) -> tuple[np.ndarray, np.ndarray]:
    """The `count` strongest bones per vertex and their weights, renormalised to 1."""
    bw = np.asarray(bw, dtype=np.float64)
    count = min(count, bw.shape[1])
    order = np.argsort(-bw, axis=1, kind="stable")[:, :count]
    values = np.take_along_axis(bw, order, axis=1)
    total = values.sum(axis=1, keepdims=True)
    empty = total[:, 0] <= 0
    total[empty] = 1.0
    values = values / total
    values[empty] = 0.0
    values[empty, 0] = 1.0
    if count < INFLUENCES:
        pad = INFLUENCES - count
        order = np.pad(order, ((0, 0), (0, pad)))
        values = np.pad(values, ((0, 0), (0, pad)))
    return order.astype(np.uint8), values.astype(np.float32)


def dense_from_top(indices: np.ndarray, values: np.ndarray, bones: int) -> np.ndarray:
    """vertices x bones weights out of four influences per vertex, rows summing to 1."""
    out = np.zeros((len(indices), bones), dtype=np.float32)
    rows = np.repeat(np.arange(len(indices)), indices.shape[1])
    np.add.at(out, (rows, indices.reshape(-1).astype(np.int64)), values.reshape(-1))
    total = out.sum(axis=1, keepdims=True)
    total[total == 0] = 1.0
    return out / total


def encode_weights(indices: np.ndarray, values: np.ndarray) -> bytes:
    floats = np.ascontiguousarray(values, dtype="<f4").tobytes()
    return floats + np.ascontiguousarray(indices, np.uint8).tobytes()


def decode_weights(blob: bytes, vertices: int, bones: int) -> tuple[np.ndarray, np.ndarray]:
    expected = vertices * INFLUENCES * 5
    if len(blob) != expected:
        raise EditError(f"edited weights are {len(blob)} bytes; {vertices} vertices need {expected}")
    split = vertices * INFLUENCES * 4
    values = np.frombuffer(blob[:split], dtype="<f4").reshape(vertices, INFLUENCES).astype(np.float32)
    indices = np.frombuffer(blob[split:], dtype=np.uint8).reshape(vertices, INFLUENCES)
    if not np.all(np.isfinite(values)) or np.any(values < 0):
        raise EditError("edited weights must be finite and not negative")
    if np.any(indices >= bones):
        raise EditError(f"edited weights name a bone past the {bones} the rig has")
    return indices, values


def describe(data: dict[str, Any]) -> dict[str, Any]:
    """`rig.json`: what the editor needs besides the mesh and the weights."""
    names = names_of(data)
    parents = np.asarray(data["parents"]).tolist() if data.get("parents") is not None else [-1] * len(names)
    mesh = data["mesh"]
    return {
        "version": 1,
        "vertexCount": len(mesh.vertices),
        "faceCount": len(mesh.faces),
        "influences": INFLUENCES,
        "removeFingers": bool(options_of(data).get("remove_fingers")),
        "bones": [
            {
                "name": name,
                "parent": int(parent),
                "head": [round(float(v), 6) for v in data["joints"][index]],
                "tail": [round(float(v), 6) for v in data["joints_tail"][index]],
            }
            for index, (name, parent) in enumerate(zip(names, parents, strict=True))
        ],
    }


def save(path: Path, data: dict[str, Any]) -> None:
    out = dict(data)
    out["mesh"] = np.array(data["mesh"], dtype=object)
    out["bones_idx_dict"] = np.array(dict(data["bones_idx_dict"]), dtype=object)
    for key in ("pose", "targets", "parents"):
        if out.get(key) is None:
            out[key] = np.array(None, dtype=object)
    if isinstance(out.get("options"), dict):
        out["options"] = json.dumps(out["options"])
    np.savez(path, **out)


def load(path: Path) -> dict[str, Any]:
    raw = np.load(path, allow_pickle=True)
    data: dict[str, Any] = {key: raw[key] for key in raw.files}
    data["mesh"] = data["mesh"].item()
    data["bones_idx_dict"] = data["bones_idx_dict"].item()
    for key in ("pose", "targets", "parents"):
        value = data.get(key)
        if value is not None and value.dtype == object and value.shape == ():
            data[key] = value.item()
    return data


def write_draft(directory: Path, data: dict[str, Any]) -> dict[str, Any]:
    """The four files the editor reads; returns `rig.json`'s content."""
    directory.mkdir(parents=True, exist_ok=True)
    save(directory / "rig.npz", data)
    # Not processed: merging or reordering vertices would break the one-to-one
    # match between the GLB's vertices and the rows of `weights.bin`.
    data["mesh"].export(directory / "mesh.glb")
    indices, values = top_influences(data["bw"])
    (directory / "weights.bin").write_bytes(encode_weights(indices, values))
    described = describe(data)
    (directory / "rig.json").write_text(json.dumps(described), encoding="utf-8")
    return described


def _point(value: Any, what: str) -> np.ndarray:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise EditError(f"{what} must be three numbers")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value):
        raise EditError(f"{what} must be three numbers")
    point = np.asarray(value, dtype=np.float64)
    if not np.all(np.isfinite(point)) or np.any(np.abs(point) > MAX_COORDINATE):
        raise EditError(f"{what} is out of range")
    return point


def apply_edits(
    data: dict[str, Any], bones: dict[str, Any] | None, edited_weights: bytes | None
) -> dict[str, Any]:
    """The draft with a person's edits: bones moved, weights repainted, T-pose rebuilt to match."""
    out = dict(data)
    index_of = data["bones_idx_dict"]
    if bones:
        if not isinstance(bones, dict):
            raise EditError("bones must map bone names to a head and a tail")
        joints = np.array(data["joints"], dtype=np.float64, copy=True)
        tails = np.array(data["joints_tail"], dtype=np.float64, copy=True)
        for name, edit in bones.items():
            if name not in index_of:
                raise EditError(f"{name!r} is not a bone of this rig")
            if not isinstance(edit, dict):
                raise EditError(f"{name}: an edit is a head and a tail")
            head = _point(edit.get("head"), f"{name}.head")
            tail = _point(edit.get("tail"), f"{name}.tail")
            if math.dist(head, tail) < 1e-5:
                raise EditError(f"{name}: head and tail are on the same spot")
            joints[index_of[name]] = head
            tails[index_of[name]] = tail
        out["joints"] = joints.astype(np.asarray(data["joints"]).dtype)
        out["joints_tail"] = tails.astype(np.asarray(data["joints_tail"]).dtype)
        targets = data.get("targets")
        if targets is not None:
            out["pose"] = pose_from_targets(targets, out["joints"], out["joints_tail"]).astype(np.float32)
    if edited_weights is not None:
        vertices = len(data["mesh"].vertices)
        indices, values = decode_weights(edited_weights, vertices, len(index_of))
        out["bw"] = dense_from_top(indices, values, len(index_of))
    return out

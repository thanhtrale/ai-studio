"""A few clips made here, on the rig itself, for when no Mixamo file is at hand.

Mixamo's clips are the good ones, but they come from Adobe one download at a
time and may not be redistributed, so the arm cannot ship them. These are
small keyframed loops written straight onto the Mixamo skeleton after its rest
has been reset to the T-pose -- no retargeting, because they are authored
against exactly that rest.

Rotations are given about world axes (Blender's: Z up, the character facing
-Y, so its right hand is at -X in the T-pose) and converted first into the
armature's space -- a Mixamo FBX armature is turned 90 degrees about X, FBX
being Y-up -- and then into each bone's own rest frame, which is what a pose
bone's quaternion is relative to.

Each clip is a list of (frame, {bone: [(axis, degrees), ...]}) keys, looped by
repeating its first key at the end.
"""

from __future__ import annotations

import math
from typing import Any

FPS = 30
X, Y, Z = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)

#: Arms from the T-pose down to the sides, which is where every clip here
#: starts. Positive about +Y lowers the left arm (at +X), negative the right.
ARMS_DOWN = {
    "LeftArm": [(Y, 68.0)],
    "RightArm": [(Y, -68.0)],
    "LeftForeArm": [(Z, -8.0)],
    "RightForeArm": [(Z, 8.0)],
}


#: The turn about the right arm's length that takes a T-pose palm from facing
#: down to facing forward, once the arm is raised.
PALM_FORWARD = 90.0


def _merge(*poses: dict[str, list]) -> dict[str, list]:
    out: dict[str, list] = {}
    for pose in poses:
        for bone, turns in pose.items():
            out.setdefault(bone, []).extend(turns)
    return out


def idle() -> list[tuple[int, dict]]:
    """Two seconds of standing: a breath in the chest, a slow sway, a glance."""
    keys = []
    for frame in range(0, 61, 10):
        phase = 2 * math.pi * frame / 60
        breath = math.sin(phase)
        keys.append(
            (
                frame,
                _merge(
                    ARMS_DOWN,
                    {
                        "Spine1": [(X, 1.5 * breath)],
                        "Spine2": [(X, 2.0 * breath)],
                        "Neck": [(X, -1.0 * breath)],
                        "Head": [(Z, 4.0 * math.sin(phase / 2))],
                        "Hips": [(Z, 1.5 * math.sin(phase))],
                        "LeftArm": [(Y, 2.0 * breath)],
                        "RightArm": [(Y, -2.0 * breath)],
                    },
                ),
            )
        )
    return keys


def wave() -> list[tuple[int, dict]]:
    """A right-handed wave: the arm comes up, the forearm swings three times, a second and a half.

    The T-pose holds the palms down. Raised without a twist, the palm ends up
    facing out to the side; a quarter turn about the forearm's length brings
    it round to face forward. The turn is split between the forearm and the
    hand, as a forearm turning the wrist over splits it, so that neither
    wrings the skin. Not the upper arm: turning that would turn the plane
    the elbow bends in, and the hand would wave forwards and back.
    """
    raised = {
        "RightArm": [(Y, 55.0), (Z, -20.0)],
        "RightForeArm": [(X, -PALM_FORWARD / 2), (Y, 60.0)],
        "RightHand": [(X, -PALM_FORWARD / 2)],
    }
    keys = []
    for frame in range(0, 46, 5):
        swing = math.sin(2 * math.pi * frame / 15)
        keys.append(
            (
                frame,
                _merge(
                    {k: v for k, v in ARMS_DOWN.items() if not k.startswith("Right")},
                    raised,
                    {
                        "RightForeArm": [(Y, 25.0 * swing)],
                        "RightHand": [(Y, 10.0 * swing)],
                        "Head": [(Z, -6.0)],
                        "Spine2": [(Y, -3.0)],
                    },
                ),
            )
        )
    return keys


def nod() -> list[tuple[int, dict]]:
    """Yes, twice, in a second."""
    keys = []
    for frame in range(0, 31, 5):
        dip = max(0.0, math.sin(2 * math.pi * frame / 15))
        keys.append((frame, _merge(ARMS_DOWN, {"Head": [(X, 14.0 * dip)], "Neck": [(X, 5.0 * dip)]})))
    return keys


BUILTIN = {"Idle": idle, "Wave": wave, "Nod": nod}


def apply(bpy: Any, mathutils: Any, armature_obj: Any, name: str) -> Any:
    """Keyframe one built-in clip onto `armature_obj` as a new action, and return it."""
    keys = BUILTIN[name]()
    keys.append((keys[-1][0] + (keys[1][0] - keys[0][0]), keys[0][1]))  # loop
    action = bpy.data.actions.new(name)
    armature_obj.animation_data_create()
    armature_obj.animation_data.action = action
    prefix = "mixamorig:"
    bones = {b.name[len(prefix) :]: b for b in armature_obj.pose.bones if b.name.startswith(prefix)}

    _, world, _ = armature_obj.matrix_world.decompose()
    to_armature = world.inverted()

    for frame, pose in keys:
        for bone in bones.values():
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        for short, turns in pose.items():
            bone = bones.get(short)
            if bone is None:
                continue
            rest = bone.bone.matrix_local.to_quaternion()
            q = mathutils.Quaternion()
            for axis, degrees in turns:
                local_axis = to_armature @ mathutils.Vector(axis)
                q = mathutils.Quaternion(local_axis, math.radians(degrees)) @ q
            bone.rotation_quaternion = rest.inverted() @ q @ rest
        for bone in bones.values():
            bone.keyframe_insert("rotation_quaternion", frame=frame + 1)
    return action

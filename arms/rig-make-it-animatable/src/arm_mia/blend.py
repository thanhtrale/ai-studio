"""The Blender half of a rig: armature, skin, clips, GLB. Run as its own process.

Make-It-Animatable predicts joints, skin weights and the pose that takes the
character to a T-pose; turning that into a file is Blender's job, through the
`bpy` module. This is `app_blender.main` from the vendored checkout, with four
changes:

- temporary files are closed before anything reopens them, which Windows
  requires and `NamedTemporaryFile` does not do
- the rest pose is always reset to the predicted T-pose, because every clip
  is authored against one
- any number of Mixamo clips, each kept as its own action, instead of one
- the output is a GLB from Blender's own exporter rather than an FBX handed
  to FBX2glTF

A process of its own because `bpy` is a whole Blender: it holds global state,
wants the main thread, and is not something a long-lived server should keep a
crash away from. Starting it costs a few seconds; a rig is not run often.

Usage: python -m arm_mia.blend <job.npz> <out.glb> <template.fbx> [clip.fbx ...]
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import vendor, weights


def is_finger(bone_name: str) -> bool:
    return any(f in bone_name for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"))


def remove_fingers(data: dict) -> dict:
    """Fold every finger into its hand: a generated mesh's fingers are fused anyway."""
    names = [None] * len(data["bones_idx_dict"])
    for name, index in data["bones_idx_dict"].items():
        names[index] = name
    keep = [i for i, name in enumerate(names) if not is_finger(name)]

    bw = data["bw"].copy()
    for i, name in enumerate(names):
        if is_finger(name):
            hand = "Left" if "Left" in name else "Right"
            bw[:, data["bones_idx_dict"][f"mixamorig:{hand}Hand"]] += bw[:, i]

    out = dict(data)
    out["joints"] = data["joints"][keep]
    out["joints_tail"] = data["joints_tail"][keep]
    out["bw"] = bw[:, keep]
    if data.get("pose") is not None:
        out["pose"] = data["pose"][keep]
    out["bones_idx_dict"] = {names[i]: j for j, i in enumerate(keep)}
    return out


def add_clip(blender_utils, bpy, armature_obj, mesh_obj, clip: Path, inplace: bool) -> str:
    """Retarget one Mixamo clip onto the armature as an action of its own, named after the file."""
    before = set(bpy.data.actions)
    anim_objs = blender_utils.load_file(str(clip))
    anim_armature = blender_utils.get_armature_obj(anim_objs)
    if anim_armature.animation_data is None or anim_armature.animation_data.action is None:
        raise ValueError(f"{clip.name} holds no animation")
    blender_utils.set_action(armature_obj, anim_armature.animation_data.action)
    blender_utils.retarget(anim_armature, armature_obj, inplace=inplace)

    action = armature_obj.animation_data.action
    action.name = clip.stem
    action.use_fake_user = True
    # Park it on an NLA track so the exporter sees it as one animation of many.
    track = armature_obj.animation_data.nla_tracks.new()
    track.name = clip.stem
    track.strips.new(clip.stem, int(action.frame_range[0]), action)
    armature_obj.animation_data.action = None

    for obj in anim_objs:
        bpy.data.objects.remove(obj, do_unlink=True)
    for leftover in set(bpy.data.actions) - before - {action}:
        bpy.data.actions.remove(leftover, do_unlink=True)
    return clip.stem


def add_builtin(bpy, mathutils, armature_obj, name: str) -> str:
    """One of `builtin_clips`, keyframed onto the T-posed rig and parked like a Mixamo clip."""
    from . import builtin_clips

    action = builtin_clips.apply(bpy, mathutils, armature_obj, name)
    action.use_fake_user = True
    track = armature_obj.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, int(action.frame_range[0]), action)
    armature_obj.animation_data.action = None
    # Back to rest, so the next clip and the exported bind pose start clean.
    for bone in armature_obj.pose.bones:
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    return name


def main(job_path: str, out_path: str, template: str, clips: list[str]) -> dict:
    vendor.install()
    import trimesh
    import util.blender_utils as blender_utils
    from util.blender_utils import bpy

    raw = np.load(job_path, allow_pickle=True)
    data = {key: raw[key] for key in raw.files}
    mesh: trimesh.Trimesh = data["mesh"].item().copy()
    data["bones_idx_dict"] = data["bones_idx_dict"].item()
    data["pose"] = None if data["pose"].dtype == object and data["pose"].item() is None else data["pose"]
    options = json.loads(str(data["options"]))
    if options.get("remove_fingers"):
        data = remove_fingers(data)
    joints, joints_tail, bw, pose = data["joints"], data["joints_tail"], data["bw"], data["pose"]
    bones_idx_dict = data["bones_idx_dict"]
    pose_ignore = list(options.get("pose_ignore", []))

    blender_utils.reset()
    template_objs = blender_utils.load_file(template)
    for obj in blender_utils.get_all_mesh_obj(template_objs):
        bpy.data.objects.remove(obj, do_unlink=True)
    armature_obj = blender_utils.get_armature_obj(template_objs)
    armature_obj.animation_data_clear()
    with blender_utils.Mode("POSE", armature_obj):
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.pose.transforms_clear()
    matrix_world = armature_obj.matrix_world.copy()
    scaling = matrix_world.to_scale()[0]
    armature_obj.matrix_world.identity()
    blender_utils.update()

    # The frame the joints are in; the copy Blender imports is turned Z-up.
    rest_verts = np.asarray(mesh.vertices).copy()
    with tempfile.TemporaryDirectory() as scratch:
        mesh_file = os.path.join(scratch, "mesh.glb")
        verts = np.asarray(mesh.vertices).copy()
        verts[:, 1], verts[:, 2] = verts[:, 2].copy(), -verts[:, 1].copy()
        mesh.vertices = verts / scaling
        mesh.export(mesh_file)
        mesh_obj = blender_utils.get_all_mesh_obj(blender_utils.load_file(mesh_file))[0]
    mesh_obj.name = mesh_obj.data.name = "mesh"
    # Smooth: trimesh's GLB carries no normals, Blender imports that as flat,
    # and the exporter then gives every triangle three vertices of its own --
    # 26K vertices out as 120K, and a file three times the size.
    polygons = mesh_obj.data.polygons
    polygons.foreach_set("use_smooth", [True] * len(polygons))

    blender_utils.set_rest_bones(armature_obj, joints / scaling, joints_tail / scaling, bones_idx_dict)
    blender_utils.set_armature_parent([mesh_obj], armature_obj)
    bw = weights.rigid_hands(bw, rest_verts, joints, bones_idx_dict)
    blender_utils.set_weights([mesh_obj], bw, bones_idx_dict)
    armature_obj.matrix_world = matrix_world
    blender_utils.remove_empty()
    blender_utils.update()

    if pose is not None:
        pose_inv = pose.copy()
        pose_inv[:, :3, 3] /= scaling
        blender_utils.set_bone_pose(armature_obj, pose_inv, bones_idx_dict, local=False)
        for bone in armature_obj.pose.bones:
            bone.location = (0, 0, 0)
            if pose_ignore and any(word in bone.name for word in pose_ignore):
                bone.matrix_basis = blender_utils.mathutils.Quaternion().to_matrix().to_4x4()
            blender_utils.update()
        blender_utils.set_rest_bones(armature_obj, reset_as_rest=True)

    names = []
    for clip in clips:
        if clip.startswith("builtin:"):
            names.append(add_builtin(bpy, blender_utils.mathutils, armature_obj, clip[len("builtin:") :]))
        else:
            names.append(
                add_clip(blender_utils, bpy, armature_obj, mesh_obj, Path(clip), options.get("inplace", True))
            )
    blender_utils.update()

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        check_existing=False,
        export_format="GLB",
        use_selection=False,
        export_animations=bool(names),
        export_animation_mode="NLA_TRACKS" if names else "ACTIONS",
        export_force_sampling=True,
        export_yup=True,
        export_skins=True,
        export_all_influences=False,
        export_image_format="AUTO",
    )
    return {
        "bones": len(bones_idx_dict),
        "clips": names,
        "vertices": len(mesh.vertices),
        "faces": len(mesh.faces),
    }


if __name__ == "__main__":
    job, out, template, *clip_paths = sys.argv[1:]
    result = main(job, out, template, clip_paths)
    # The parent reads the last line.
    print("RESULT " + json.dumps(result), flush=True)
    # Straight out: `bpy` tears itself down at interpreter exit and, on this
    # build, faults doing it (0xC0000005) after the file is long written.
    os._exit(0)

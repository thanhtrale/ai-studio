"""
Catalog clip Mixamo: dataset `jasongzy/Mixamo` đặt tên clip bằng HASH, FBX cũng không mang tên gốc
("Retargeted Clip; Motion Sequence"). Script này đo đặc trưng chuyển động của từng clip rồi gắn nhãn
thô theo luật, để chọn được idle/walk/run/jump/wave/dance mà không phải xem 2453 clip.

    python arms/mia-rig/catalog.py                    # quét E:/ai-models/rig/mixamo/animation
    python arms/mia-rig/catalog.py --limit 50         # thử

Ra: <gốc>/rig/mixamo/catalog.json — {hash: {frames, fps, feats…, tags[]}}. Nhãn là ĐOÁN, chỉ để lọc;
clip được chọn cho nhân vật phải xem lại bằng ảnh render (bước rig làm việc đó).

Chạy bằng python của venv `mia-venv` (cần bpy). Chỉ CPU.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import bpy  # noqa: E402  — nạp TRƯỚC numpy/trimesh, xem rig.py
import numpy as np

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ai-studio: the studio's managed models directory.
ROOT = Path(os.environ.get("AISTUDIO_MODELS_DIR") or Path(__file__).resolve().parents[3] / "storage" / "models") / "rig" / "mixamo"
TRACK = ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot", "Spine2"]


def measure(path: Path, step: int) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(path))
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    act = arm.animation_data.action if arm.animation_data else None
    if act is None:
        raise RuntimeError("no action")
    f0, f1 = (int(round(x)) for x in act.frame_range)
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    frames = list(range(f0, f1 + 1, step))
    pb = {n: arm.pose.bones.get(f"mixamorig:{n}") for n in TRACK}
    if any(v is None for v in pb.values()):
        raise RuntimeError("missing bones")
    pos = np.zeros((len(frames), len(TRACK), 3))
    mw = arm.matrix_world
    for i, f in enumerate(frames):
        bpy.context.scene.frame_set(f)
        for j, n in enumerate(TRACK):
            pos[i, j] = mw @ pb[n].head
    # Z lên trong Blender. Chiều cao thân = khoảng Hips→Head ở khung đầu (×~2,2 là cả người).
    torso = float(np.linalg.norm(pos[0, 1] - pos[0, 0])) or 1.0
    P = pos / torso
    hips = P[:, 0]
    dt = step / fps
    dur = (f1 - f0) / fps
    horiz = hips[:, :2] - hips[0, :2]
    rel = P - hips[:, None, :]  # chuyển động tương đối thân
    speed = np.linalg.norm(np.diff(rel, axis=0), axis=-1) / dt if len(frames) > 1 else np.zeros((1, len(TRACK)))
    head_z = P[:, 1, 2]
    hand_up = np.maximum(P[:, 2, 2], P[:, 3, 2]) > head_z
    one_hand_up = (P[:, 2, 2] > head_z) ^ (P[:, 3, 2] > head_z)
    feats = {
        "frames": f1 - f0 + 1,
        "fps": round(fps, 2),
        "durS": round(dur, 2),
        "rootTravel": round(float(np.linalg.norm(horiz[-1])), 3),
        "rootSpeed": round(float(np.linalg.norm(horiz[-1]) / max(dur, 1e-6)), 3),
        "rootZRange": round(float(hips[:, 2].max() - hips[:, 2].min()), 3),
        "rootZMin": round(float(hips[:, 2].min() - hips[0, 2]), 3),
        "handSpeed": round(float(speed[:, 2:4].mean()), 3),
        "footSpeed": round(float(speed[:, 4:6].mean()), 3),
        "headSpeed": round(float(speed[:, 1].mean()), 3),
        "handUp": round(float(hand_up.mean()), 3),
        "oneHandUp": round(float(one_hand_up.mean()), 3),
    }
    feats["tags"] = tags(feats)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    return feats


def tags(f: dict) -> list[str]:
    """Luật thô, đơn vị = chiều dài thân (Hips→Head). Chỉ để LỌC — clip chọn phải xem lại."""
    t = []
    energy = f["handSpeed"] + f["footSpeed"] + f["headSpeed"]
    if energy < 0.6 and f["rootSpeed"] < 0.15 and f["rootZRange"] < 0.15:
        t.append("idle")
    if 0.5 <= f["rootSpeed"] < 2.2 and f["footSpeed"] > 0.8 and f["rootZRange"] < 0.35:
        t.append("walk")
    if f["rootSpeed"] >= 2.2 and f["footSpeed"] > 1.5:
        t.append("run")
    if f["rootZRange"] >= 0.45 and f["rootZMin"] > -0.4:
        t.append("jump")
    if f["oneHandUp"] > 0.35 and f["footSpeed"] < 0.5 and f["rootSpeed"] < 0.2:
        t.append("wave")
    if energy > 3.0 and f["rootSpeed"] < 0.5 and f["durS"] > 4:
        t.append("dance")
    if f["rootZMin"] < -0.6:
        t.append("low")  # ngồi / nằm / ngã
    return t


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--step", type=int, default=3)
    a = ap.parse_args()
    out = ROOT / "catalog.json"
    cat = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    files = sorted((ROOT / "animation").glob("*.fbx"))
    if a.limit:
        files = files[: a.limit]
    t0 = time.time()
    for i, p in enumerate(files):
        if p.stem in cat:
            continue
        try:
            cat[p.stem] = measure(p, a.step)
        except Exception as e:
            cat[p.stem] = {"error": str(e)}
        if i % 50 == 0:
            out.write_text(json.dumps(cat), encoding="utf-8")
            print(f"{i + 1}/{len(files)}  {time.time() - t0:.0f}s", flush=True)
    out.write_text(json.dumps(cat), encoding="utf-8")
    from collections import Counter

    print("tags:", Counter(t for v in cat.values() for t in v.get("tags", [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
Ảnh kiểm tra cho mesh và rig — Blender (bpy 4.3) Workbench, chạy trong venv của arm `mia-rig`.

    python render.py '{"glb": "...mesh.glb", "out": "...renders", "mode": "turntable"}'
    python render.py '{"glb": "...rigged.glb", "out": "...renders", "mode": "anim", "frames": 8}'

VÌ SAO WORKBENCH, không EEVEE/Cycles: ảnh này để SOÁT LỖI, không để đẹp. Workbench ~0,5 s/khung, có
hai chế độ cần đúng cho việc soát: `TEXTURE` (màu đã bake, không bóng đổ đè lên) và `SINGLE` (đất
sét xám — lộ hình khối thật, không để texture che hõm/lồi). EEVEE lần đầu mất ~19 s biên dịch shader.

Đầu ra (mọi file PNG nền trắng):
  turntable: tex_000.png … tex_315.png (8 góc, 45° một), clay_000/090/180/270.png, face_front.png,
             face_34.png, detail_*.png + sheet_detail.png (cận mắt, dây buộc tóc, lòng tay áo — `detail_shots`),
             sheet_tex.png, sheet_clay.png (ghép), info.json (bbox, số mặt, số đỉnh)
  anim:      <tên clip>/f00.png …, sheet_<tên clip>.png, rest_bones.png (mesh trong suốt + que xương);
             mỗi clip đo `stretch` (giãn cạnh) và `handInBody` (bàn tay lọt thân, 30 khung — phép thử sau mỗi lần rig)

Giao thức: JSON-lines ra stdout như arm (`step`, `done`, `error`).
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

_PROTO = sys.stdout
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
sys.stdout = sys.stderr

import bpy  # noqa: E402
import mathutils  # noqa: E402

T0 = time.time()


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: str) -> list:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def mesh_objs() -> list:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_bbox(objs) -> tuple[mathutils.Vector, mathutils.Vector]:
    deps = bpy.context.evaluated_depsgraph_get()
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    for o in objs:
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        mw = o.matrix_world
        for v in me.vertices:
            p = mw @ v.co
            lo = mathutils.Vector(map(min, lo, p))
            hi = mathutils.Vector(map(max, hi, p))
        ev.to_mesh_clear()
    return lo, hi


def setup_scene(res: int) -> bpy.types.Scene:
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x = sc.render.resolution_y = res
    sc.render.film_transparent = False
    sc.display.shading.light = "STUDIO"
    sc.display.shading.show_cavity = False
    sc.display.shading.show_object_outline = False
    sc.display.shading.background_type = "VIEWPORT"
    sc.display.shading.background_color = (1, 1, 1)
    sc.view_settings.view_transform = "Standard"
    if sc.world is None:
        sc.world = bpy.data.worlds.new("w")
    sc.world.color = (1, 1, 1)
    return sc


def camera(sc, center, size: float, az_deg: float, el_deg: float = 8.0, ortho_scale: float | None = None):
    cam = sc.camera
    if cam is None:
        cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
        sc.collection.objects.link(cam)
        sc.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho_scale or size * 1.15
    # Góc 0 = nhìn từ PHÍA TRƯỚC nhân vật. Mesh Pixal3D/glTF: Y-up, mặt trước hướng +Z, Blender
    # nhập glTF đổi sang Z-up nên mặt trước hướng -Y. Camera đứng ở -Y nhìn về +Y.
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = size * 4
    off = mathutils.Vector((d * math.sin(az) * math.cos(el), -d * math.cos(az) * math.cos(el), d * math.sin(el)))
    cam.location = center + off
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.clip_end = d * 4
    return cam


def shot(sc, path: Path) -> str:
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return str(path)


def sheet(paths: list[str], out: Path, cols: int) -> str | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    ims = [Image.open(p).convert("RGB") for p in paths]
    w, h = ims[0].size
    rows = math.ceil(len(ims) / cols)
    canvas = Image.new("RGB", (w * cols, h * rows), "white")
    for i, im in enumerate(ims):
        canvas.paste(im, ((i % cols) * w, (i // cols) * h))
    canvas.save(out)
    return str(out)


def detail_shots(sc, objs, lo, hi, size: float, out: Path) -> list[str]:
    """Cận những chỗ Pixal3D hay tô hỏng mà ảnh turntable thu nhỏ che mất (người dùng bắt ở r167): mắt + lông
    mày (trước, 3/4), dây buộc tóc (sau, bên — mảng xanh lạc trên tóc), cẳng tay + cổ tay áo nhìn từ DƯỚI và từ
    sau (lòng tay áo, da sát mép tay áo). Tỉ lệ theo chibi (đầu ~40% thân); nhân vật khác tỉ lệ thì khung lệch."""
    import numpy as np

    d = hi - lo
    H = d.z
    c = (lo + hi) / 2
    paths: list[str] = []

    def one(name: str, center, az: float, el: float, scale: float) -> None:
        camera(sc, center, size, az, el, ortho_scale=H * scale)
        paths.append(shot(sc, out / f"detail_{name}.png"))

    eyes = mathutils.Vector((c.x, c.y, hi.z - H * 0.335))
    one("eyes_front", eyes, 0, 2, 0.16)
    one("eyes_34", eyes, 35, 2, 0.16)
    top = mathutils.Vector((c.x, c.y, hi.z - H * 0.12))
    one("tie_back", top, 180, 25, 0.24)
    one("tie_side", top, 90, 25, 0.24)
    # Cẳng tay: đỉnh ở xa trục thân (> 30% bề ngang) trong dải cao 40–75% — tâm khung = trung vị của chúng.
    V = np.concatenate([np.array([o.matrix_world @ v.co for v in o.data.vertices]) for o in objs])
    for side, sx in (("R", -1), ("L", 1)):
        m = (sx * (V[:, 0] - c.x) > d.x * 0.30) & (V[:, 2] > lo.z + H * 0.40) & (V[:, 2] < lo.z + H * 0.75)
        if m.any():
            arm = mathutils.Vector(np.median(V[m], axis=0))
            one(f"sleeve_{side}_below", arm, 0, -50, 0.2)
            one(f"sleeve_{side}_back", arm, 180, -40, 0.2)
    return paths


def turntable(job: dict) -> dict:
    out = Path(job["out"])
    out.mkdir(parents=True, exist_ok=True)
    reset()
    import_glb(job["glb"])
    objs = mesh_objs()
    if not objs:
        raise RuntimeError("no mesh in GLB")
    sc = setup_scene(int(job.get("res") or 768))
    lo, hi = world_bbox(objs)
    center = (lo + hi) / 2
    dims = hi - lo
    size = max(dims.x, dims.y, dims.z)
    faces = sum(len(o.data.polygons) for o in objs)
    verts = sum(len(o.data.vertices) for o in objs)

    files: dict[str, list[str] | str] = {"tex": [], "clay": []}
    # FLAT cho ảnh texture: so MÀU với ref. Studio làm áo trắng thành xám nhạt — đọc nhầm thành lỗi bake.
    sc.display.shading.color_type = "TEXTURE"
    sc.display.shading.light = "FLAT"
    angles = list(range(0, 360, 45))
    for i, a in enumerate(angles):
        camera(sc, center, size, a)
        files["tex"].append(shot(sc, out / f"tex_{a:03d}.png"))
        emit("step", stage="render-tex", i=i + 1, of=len(angles))
    # Cận mặt. Tâm mặt tính từ ĐỈNH bbox theo tỉ lệ chiều cao: chibi (đầu ~45% thân, búi tóc là
    # đỉnh) ~0,36; người tỉ lệ thường ~0,08. Đặt sai là khung chỉ thấy tóc — đã dính ở r03.
    k = float(job.get("faceFromTop") or 0.36)
    head_c = mathutils.Vector((center.x, center.y, hi.z - dims.z * k))
    for name, a in (("face_front", 0), ("face_34", 35)):
        camera(sc, head_c, size, a, 4, ortho_scale=dims.z * float(job.get("faceScale") or 0.42))
        files[name] = shot(sc, out / f"{name}.png")
    files["detail"] = detail_shots(sc, objs, lo, hi, size, out)
    files["sheet_detail"] = sheet(files["detail"], out / "sheet_detail.png", 4) or ""
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "SINGLE"
    sc.display.shading.single_color = (0.75, 0.75, 0.75)
    sc.display.shading.show_cavity = True
    for i, a in enumerate((0, 90, 180, 270)):
        camera(sc, center, size, a)
        files["clay"].append(shot(sc, out / f"clay_{a:03d}.png"))
    files["sheet_tex"] = sheet(files["tex"], out / "sheet_tex.png", 4) or ""
    files["sheet_clay"] = sheet(files["clay"], out / "sheet_clay.png", 4) or ""
    info = {"faces": faces, "verts": verts, "bbox": [list(lo), list(hi)], "height": dims.z,
            "aspect": {"widthOverHeight": dims.x / dims.z if dims.z else None, "depthOverHeight": dims.y / dims.z if dims.z else None}}
    (out / "info.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    return {"files": files, "info": info}


def bone_sticks(arm_obj, thick: float) -> list:
    """Que xương: khớp cha → khớp con, màu đỏ — Workbench không vẽ armature.

    KHÔNG dùng `tail` của bone: importer glTF của Blender tự đoán độ dài bone, ra số vô lý (r15:
    Hips dài 1212 đơn vị trong khi cả người cao ~90) → que phủ kín khung.
    """
    mat = bpy.data.materials.new("bone")
    mat.diffuse_color = (0.9, 0.1, 0.1, 1)
    out = []
    for b in arm_obj.pose.bones:
        h = arm_obj.matrix_world @ b.head
        for c in b.children:
            t = arm_obj.matrix_world @ c.head
            L = (t - h).length
            if L < 1e-6:
                continue
            bpy.ops.mesh.primitive_cylinder_add(radius=thick, depth=L, location=(h + t) / 2)
            cyl = bpy.context.active_object
            cyl.rotation_euler = (t - h).to_track_quat("Z", "Y").to_euler()
            cyl.data.materials.append(mat)
            out.append(cyl)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=thick * 1.8, location=h)
        sph = bpy.context.active_object
        sph.data.materials.append(mat)
        out.append(sph)
    return out


def edge_lengths(objs) -> "np.ndarray":
    """Độ dài mọi cạnh của mesh ĐÃ BIẾN DẠNG (armature áp vào), nối các object theo thứ tự."""
    import numpy as np

    deps = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        ed = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get("vertices", ed)
        co = co.reshape(-1, 3)
        ed = ed.reshape(-1, 2)
        out.append(np.linalg.norm(co[ed[:, 0]] - co[ed[:, 1]], axis=1))
        ev.to_mesh_clear()
    return np.concatenate(out) if out else np.zeros(0)


def stretch(base, cur) -> dict:
    """Tỉ lệ dài cạnh khung / tư thế nghỉ. Gập khớp làm p99 nhích lên; mesh bị KÉO THÀNH DẢI (trọng số
    rò, r15/r17) làm max vọt lên hàng chục lần — đó là thứ thước này bắt."""
    import numpy as np

    # Bỏ cạnh ngắn hơn nửa trung vị: remesh của Pixal3D để lại cạnh gần 0, chia cho nó là tỉ lệ vọt lên
    # hàng trăm mà mắt không thấy gì (r18: max 239 ở đầu gối).
    ok = base > 0.5 * float(np.median(base))
    r = cur[ok] / base[ok]
    return {"p99": round(float(np.percentile(r, 99)), 3), "p999": round(float(np.percentile(r, 99.9)), 3),
            "max": round(float(r.max()), 2), "over2": round(float((r > 2).mean()), 5)}


HAND_IN_BODY_FRAMES = 30
TORSO = {"mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2"}


def hand_in_body_setup(objs) -> list:
    """Đỉnh thân (xương trội Hips/Spine/Spine1/Spine2) + 300 đỉnh mỗi bàn tay (xương trội Left/RightHand), theo mesh."""
    import numpy as np

    rng = np.random.default_rng(0)
    parts = []
    for o in objs:
        if not o.vertex_groups:
            continue
        names = {g.index: g.name for g in o.vertex_groups}
        dom = np.array([names.get(max(v.groups, key=lambda g: g.weight).group, "") if v.groups else "" for v in o.data.vertices])
        torso = np.flatnonzero(np.isin(dom, list(TORSO)))
        hand = {}
        for side in ("Left", "Right"):
            ix = np.flatnonzero(dom == f"mixamorig:{side}Hand")
            hand[side] = rng.choice(ix, min(300, len(ix)), replace=False) if len(ix) else ix
        parts.append((o, torso, hand))
    return parts


def hand_in_body(arm_obj, parts, act, H: float) -> dict:
    """PHÉP THỬ SAU MỖI LẦN RIG: bàn tay lọt vào thân (người dùng bắt ở r44: Walk cuối clip chống tay sau hông,
    Idle chống hông, Dance/Jump xoay người). Đỉnh tay p, đỉnh thân gần nhất v, điểm a gần nhất trên trục sống
    (Hips → Neck): p "trong thân" khi |p−a| < |v−a| − 0,004·H và |p−v| < 0,06·H — đo theo bán kính quanh trục
    sống, không theo pháp tuyến (vỏ hai lớp của Pixal3D). Khung lọt = một tay có ≥ 5% đỉnh trong thân.
    Đã soát bằng ảnh 4 góc (log char3d r44/r45). Đo độc lập với `TorsoClearance` của rig.py (hồ sơ bán kính)."""
    import numpy as np
    from mathutils import Vector
    from mathutils.kdtree import KDTree

    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    chain_n = ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:Neck"]
    if not parts or any(n not in arm_obj.pose.bones for n in chain_n):
        return {}

    def coords(o):
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        c = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", c)
        ev.to_mesh_clear()
        M = np.array(o.matrix_world)
        return c.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]

    def near_axis(P, C):
        best = np.full(len(P), np.inf)
        out = np.zeros_like(P)
        for a, b in zip(C[:-1], C[1:]):
            ab = b - a
            t = np.clip(((P - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
            q = a + t[:, None] * ab
            d = np.linalg.norm(P - q, axis=1)
            m = d < best
            best[m], out[m] = d[m], q[m]
        return out

    f0, f1 = (int(x) for x in act.frame_range)
    frames = sorted({round(f0 + (f1 - f0) * k / (HAND_IN_BODY_FRAMES - 1)) for k in range(HAND_IN_BODY_FRAMES)})
    hit, worst, worst_f = [], 0.0, None
    for f in frames:
        sc.frame_set(f)
        allc = [coords(o) for o, _, _ in parts]
        tc = np.concatenate([c[t] for c, (_, t, _) in zip(allc, parts)])
        if not len(tc):
            return {}
        kd = KDTree(len(tc))
        for i, p in enumerate(tc):
            kd.insert(Vector(p), i)
        kd.balance()
        W = arm_obj.matrix_world
        C = np.array([list(W @ arm_obj.pose.bones[n].head) for n in chain_n])
        frame_hit = False
        for side in ("Left", "Right"):
            P = np.concatenate([c[h[side]] for c, (_, _, h) in zip(allc, parts) if len(h[side])]) if parts else np.zeros((0, 3))
            if not len(P):
                continue
            V = np.array([tc[kd.find(Vector(p))[1]] for p in P])
            a = near_axis(P, C)
            inside = (np.linalg.norm(P - a, axis=1) < np.linalg.norm(V - a, axis=1) - 0.004 * H) & (np.linalg.norm(P - V, axis=1) < 0.06 * H)
            frac = float(inside.mean())
            if frac > worst:
                worst, worst_f = frac, f
            frame_hit |= frac >= 0.05
        if frame_hit:
            hit.append(f)
    return {"frames": len(hit), "of": len(frames), "worstHandShare": round(worst, 3), "worstFrame": worst_f, "hitFrames": hit}


def anim(job: dict) -> dict:
    out = Path(job["out"])
    out.mkdir(parents=True, exist_ok=True)
    reset()
    import_glb(job["glb"])
    sc = setup_scene(int(job.get("res") or 512))
    arms_ = [o for o in sc.objects if o.type == "ARMATURE"]
    if not arms_:
        raise RuntimeError("no armature in GLB")
    arm_obj = arms_[0]
    objs = mesh_objs()
    n = int(job.get("frames") or 8)
    files: dict = {"clips": {}}

    # Tư thế nghỉ + que xương, mesh nửa trong suốt (x-ray).
    if arm_obj.animation_data:
        arm_obj.animation_data.action = None
        for tr in list(arm_obj.animation_data.nla_tracks):
            tr.mute = True
    for pb in arm_obj.pose.bones:
        pb.matrix_basis = mathutils.Matrix()
    bpy.context.view_layer.update()
    lo, hi = world_bbox(objs)
    center, size = (lo + hi) / 2, max(hi - lo)
    sticks = bone_sticks(arm_obj, size * 0.006)
    sc.display.shading.color_type = "MATERIAL"
    sc.display.shading.show_xray = True
    sc.display.shading.xray_alpha = 0.35
    rest = []
    for a in (0, 90):
        camera(sc, center, size, a)
        rest.append(shot(sc, out / f"rest_bones_{a:03d}.png"))
    files["rest_bones"] = sheet(rest, out / "rest_bones.png", 2) or rest[0]
    for s in sticks:
        bpy.data.objects.remove(s, do_unlink=True)
    sc.display.shading.show_xray = False
    sc.display.shading.color_type = "TEXTURE"
    sc.display.shading.light = "FLAT"
    base = edge_lengths(objs)
    hib_parts = hand_in_body_setup(objs)
    H = float((hi - lo).z)

    actions = [a for a in bpy.data.actions if a.users or a.use_fake_user]
    for ai, act in enumerate(actions):
        if arm_obj.animation_data is None:
            arm_obj.animation_data_create()
        arm_obj.animation_data.action = act
        f0, f1 = (int(x) for x in act.frame_range)
        frames = [round(f0 + (f1 - f0) * k / max(1, n - 1)) for k in range(n)]
        name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in act.name)[:40]
        d = out / name
        d.mkdir(exist_ok=True)
        # Khung hình cố định theo tư thế nghỉ, nới rộng để clip chạy/nhảy không ra khỏi khung.
        imgs = []
        st = []
        for k, f in enumerate(frames):
            sc.frame_set(f)
            st.append(stretch(base, edge_lengths(objs)))
            camera(sc, center, size * 1.15, 30)
            imgs.append(shot(sc, d / f"f{k:02d}.png"))
        worst = max(st, key=lambda x: x["max"]) if st else {}
        files["clips"][act.name] = {"frames": imgs, "range": [f0, f1], "stretch": st, "stretchWorst": worst,
                                    "handInBody": hand_in_body(arm_obj, hib_parts, act, H),
                                    "sheet": sheet(imgs, out / f"sheet_{name}.png", min(n, 4)) or ""}
        emit("step", stage="render-anim", i=ai + 1, of=len(actions))
    return {"files": files}


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        r = turntable(job) if job.get("mode", "turntable") == "turntable" else anim(job)
        emit("done", **r)
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit("error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

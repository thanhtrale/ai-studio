"""
Dọn mesh trước khi rig — Blender (bpy 4.3), chỉ CPU, chạy trong venv của arm `mia-rig`.

    python prep.py '{"mesh": ".../mesh.glb", "out": ".../prep.glb", "faces": 60000, "voxel": 0.0015, "texture": 2048}'

VÌ SAO: mesh Pixal3D là mesh để HIỂN THỊ, không để rig (đo r06/r39/r43/r49): 61–68% đỉnh có một mặt
quay ngược nằm sát bên trong 0,4% chiều cao (remesh UDF đẻ ra VỎ MỎNG HAI LỚP quanh bề mặt), 1600–2500
cạnh non-manifold, không kín, 3–22 mảnh rời, 300k mặt. Rig dựa trên lân cận (MIA theo điểm, bone heat theo
bề mặt) trộn hai lớp và các mảnh với nhau.

Các bước:
  0. `hairCut` (mặc định 0,2; false = tắt): bỏ TÓC RỦ dưới cằm — tóc dài làm MIA nhận đuôi tóc là cánh tay. Toạ độ
     đỉnh đã cắt ghi ra `<out>_hair.npy`; rig.py gán chúng theo Head → Spine2. Xem `cut_hanging_hair`.
  1. voxel remesh (`voxel`·chiều cao, mặc định 0,0015) → MỘT vỏ kín, hai lớp sát nhau nhập làm một
  2. bỏ mảnh liền nhỏ hơn `minPart` (tỉ lệ số đỉnh) — vụn bay lơ lửng
  3. decimate (collapse) về ~`faces` mặt
  4. UV mới (smart project) + bake MÀU NỀN từ mesh gốc (Cycles, selected → active, CPU). Chỉ màu nền: AO
     của Pixal3D bake cho tư thế tĩnh, lộ thành mảng đen khi tay đổi tư thế (log r22–r27).

KHÔNG tách được chỗ HÀN (tay áo dính sườn) — đó là việc của ảnh ref (docs/char3d.md).

Giao thức: JSON-lines ra stdout như arm (`step`, `done`, `error`).
"""

from __future__ import annotations

import json
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
import bmesh  # noqa: E402

T0 = time.time()
PH: dict[str, int] = {}


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def phase(name: str, t: float) -> None:
    PH[name] = int((time.time() - t) * 1000)
    emit("step", stage=name, ms_phase=PH[name])


def components(obj) -> list[list[int]]:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    seen: set = set()
    out = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        seen.add(v.index)
        while stack:
            x = stack.pop()
            comp.append(x.index)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
        out.append(comp)
    bm.free()
    return sorted(out, key=len, reverse=True)


def drop_small(obj, min_frac: float) -> dict:
    comps = components(obj)
    n = sum(len(c) for c in comps)
    drop = {i for c in comps if len(c) < min_frac * n for i in c}
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in drop], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    return {"components": len(comps), "kept": sum(1 for c in comps if len(c) >= min_frac * n), "droppedVerts": len(drop)}


def neck_height(obj) -> float:
    """Độ cao CẰM/cổ: lát CAO NHẤT trong dải hẹp (bề ngang P90 ≤ 1,1 × lát hẹp nhất) ở 50–80% chiều cao.

    Không lấy lát hẹp nhất như HeadShrink: tóc rủ quanh cổ làm bề ngang phẳng suốt dải vai → cằm (co-be-vo-sinh-hong
    r28: 0,106–0,116·H từ 0,60 tới 0,675) — argmin rơi xuống đáy dải (0,60, ngang vai) và bỏ sót tóc ở hai bên cổ."""
    import numpy as np

    V = np.array([v.co[:] for v in obj.data.vertices], dtype=np.float64)
    z = V[:, 2]
    lo, hi = float(z.min()), float(z.max())
    H = hi - lo
    cx = float(np.median(V[:, 0]))
    rows = []
    for k in range(40, 64):
        a = lo + H * k / 80
        sl = V[(z >= a) & (z < a + H / 80)]
        if len(sl) >= 20:
            rows.append((float(np.percentile(np.abs(sl[:, 0] - cx), 90)), a + H / 160))
    if not rows:
        return lo + 0.65 * H
    wmin = min(w for w, _ in rows)
    return max(zz for w, zz in rows if w <= 1.1 * wmin)


def cut_hanging_hair(obj, lum_max: float) -> tuple[dict, list]:
    """Bỏ TÓC RỦ dưới cổ khỏi bản để rig: mặt tối (độ sáng màu nền < `lum_max`) LIỀN với vùng tối trên cổ (tóc trên đầu),
    loang qua cạnh chung, chỉ trong các mặt tối; xoá phần loang nằm dưới cổ.

    VÌ SAO (log co-be-vo-sinh-hong r29–r31): tóc dài rủ tới thắt lưng làm MIA nhận đuôi tóc là cánh tay — Hips 0,56·H
    (đúng ~0,43), vai 0,80·H trong đầu, tay trái chĩa ra sau vào đuôi tóc; hai lượt như nhau. Cắt tóc rủ: Hips 0,43, vai
    0,60, hai tay đối xứng. Loang từ tóc trên đầu để KHÔNG đụng quần/giày tối màu (không liền với tóc qua mặt tối).
    Tóc sáng màu (vàng, bạc) không bắt được — chưa gặp. Trả về (thống kê, toạ độ đỉnh đã cắt) — rig.py dùng toạ độ đó để
    cho tóc nhận trọng số của thân/cổ/đầu khi chép về mesh gốc."""
    import numpy as np

    img = None
    for m in obj.data.materials:
        if m and m.use_nodes:
            for nd in m.node_tree.nodes:
                if nd.type == "TEX_IMAGE" and nd.image and any(l.to_socket.name == "Base Color" for l in nd.outputs[0].links):
                    img = nd.image
    if img is None or not obj.data.uv_layers:
        return {"skipped": "no base color texture"}, []
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, img.channels)
    neck = neck_height(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uvl = bm.loops.layers.uv.active
    n = len(bm.faces)
    dark = np.zeros(n, dtype=bool)
    above = np.zeros(n, dtype=bool)
    for f in bm.faces:
        u = sum(l[uvl].uv.x for l in f.loops) / len(f.loops)
        v = sum(l[uvl].uv.y for l in f.loops) / len(f.loops)
        p = px[min(h - 1, max(0, int(v * h))), min(w - 1, max(0, int(u * w)))]
        dark[f.index] = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] < lum_max
        above[f.index] = f.calc_center_median().z >= neck
    # Loang theo KHOẢNG CÁCH (tâm mặt cách nhau < 0,006·H), không theo cạnh chung: tóc Pixal3D là nhiều lọn rời và có
    # vệt bóng sáng cắt ngang — loang theo cạnh chỉ bắt được 7,8k/26k mặt tóc dưới cổ (r28).
    from scipy.spatial import cKDTree

    H = max(obj.dimensions)
    C = np.array([f.calc_center_median()[:] for f in bm.faces], dtype=np.float64)
    di = np.nonzero(dark)[0]
    tree = cKDTree(C[di])
    seen = dark & above
    front = np.nonzero(seen)[0]
    while len(front):
        nb = tree.query_ball_point(C[front], r=0.006 * H)
        cand = np.unique(di[np.concatenate([np.asarray(x, dtype=np.int64) for x in nb])]) if len(nb) else np.zeros(0, np.int64)
        new = cand[~seen[cand]]
        seen[new] = True
        front = new
    kill = [bm.faces[i] for i in np.nonzero(seen & ~above)[0]]
    pts = list({tuple(v.co) for f in kill for v in f.verts})
    stats = {"neckFrac": round((neck - min(v.co.z for v in bm.verts)) / H, 3), "darkFaces": int(dark.sum()), "cutFaces": len(kill)}
    bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
    bm.to_mesh(obj.data)
    bm.free()
    return stats, pts


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        src, out = str(job["mesh"]), Path(str(job["out"]))
        faces = int(job.get("faces") or 60000)
        # 0,0015 (không phải 0,003): vỏ hai lớp Pixal3D dày ~0,004·H; voxel 0,003 làm THỦNG vỏ chỗ mỏng → MIA đặt cổ
        # tay trùng khuỷu ở 5/6 lượt trên mesh r95 (log r97–r107); 0,0015 thì 3/3 đúng, r49 vẫn ngang r63.
        voxel = float(job.get("voxel") or 0.0015)
        tex = int(job.get("texture") or 2048)
        min_part = float(job.get("minPart") or 0.002)
        # bake=false: chỉ hình học (mesh để RIG; texture giữ ở mesh gốc, trọng số chép về đó — rig.py `prep`).
        bake = job.get("bake", True) is not False

        t = time.time()
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=src)
        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        if not meshes:
            raise RuntimeError("no mesh in GLB")
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        if len(meshes) > 1:
            bpy.ops.object.join()
        orig = bpy.context.view_layer.objects.active
        # Áp transform để proxy và bản gốc cùng hệ toạ độ thế giới khi bake.
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        H = max(orig.dimensions)
        stats: dict = {"srcFaces": len(orig.data.polygons), "srcVerts": len(orig.data.vertices)}
        phase("import", t)

        t = time.time()
        new = orig.copy()
        new.data = orig.data.copy()
        new.name = "prep"
        bpy.context.scene.collection.objects.link(new)
        # hairCut: số = ngưỡng độ sáng (mặc định 0,2); false = tắt. Cắt trên bản sao TRƯỚC khi bỏ vật liệu (cần texture).
        hair_cfg = job.get("hairCut", 0.2)
        if hair_cfg is not False and hair_cfg is not None:
            hs, hpts = cut_hanging_hair(new, float(hair_cfg))
            stats["hairCut"] = hs
            if hpts:
                import numpy as np

                np.save(out.with_name(out.stem + "_hair.npy"), np.asarray(hpts, dtype=np.float32))
            phase("hair-cut", t)
            t = time.time()
        new.data.materials.clear()
        mod = new.modifiers.new("vox", "REMESH")
        mod.mode = "VOXEL"
        mod.voxel_size = H * voxel
        bpy.context.view_layer.objects.active = new
        bpy.ops.object.modifier_apply(modifier="vox")
        stats["voxelFaces"] = len(new.data.polygons)
        stats.update(drop_small(new, min_part))
        phase("voxel", t)

        t = time.time()
        # Voxel remesh ra QUAD; decimate tính theo TAM GIÁC → đếm tam giác.
        cur = sum(len(p.vertices) - 2 for p in new.data.polygons)
        if cur > faces:
            dec = new.modifiers.new("dec", "DECIMATE")
            dec.decimate_type = "COLLAPSE"
            dec.ratio = faces / cur
            dec.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier="dec")
        stats["faces"] = sum(len(p.vertices) - 2 for p in new.data.polygons)
        stats["verts"] = len(new.data.vertices)
        for p in new.data.polygons:
            p.use_smooth = True
        phase("decimate", t)

        if not bake:
            bpy.data.objects.remove(orig, do_unlink=True)
            bpy.ops.object.select_all(action="DESELECT")
            new.select_set(True)
            out.parent.mkdir(parents=True, exist_ok=True)
            bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_format="GLB")
            emit("done", path=str(out), stats=stats, phaseMs=PH)
            return 0

        t = time.time()
        bpy.ops.object.select_all(action="DESELECT")
        new.select_set(True)
        bpy.context.view_layer.objects.active = new
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.003)
        bpy.ops.object.mode_set(mode="OBJECT")
        phase("uv", t)

        t = time.time()
        img = bpy.data.images.new("prep_basecolor", tex, tex, alpha=False)
        mat = bpy.data.materials.new("prep")
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.8
        bsdf.inputs["Metallic"].default_value = 0.0
        new.data.materials.append(mat)
        nt.nodes.active = node
        sc = bpy.context.scene
        sc.render.engine = "CYCLES"
        sc.cycles.device = "CPU"
        sc.cycles.samples = 1
        sc.render.bake.use_selected_to_active = True
        sc.render.bake.cage_extrusion = H * 0.01
        sc.render.bake.max_ray_distance = H * 0.03
        sc.render.bake.use_pass_direct = False
        sc.render.bake.use_pass_indirect = False
        sc.render.bake.use_pass_color = True
        sc.render.bake.margin = 8
        bpy.ops.object.select_all(action="DESELECT")
        orig.select_set(True)
        new.select_set(True)
        bpy.context.view_layer.objects.active = new
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True)
        out.parent.mkdir(parents=True, exist_ok=True)
        img.filepath_raw = str(out.with_name(out.stem + "_basecolor.png"))
        img.file_format = "PNG"
        img.save()
        phase("bake", t)

        t = time.time()
        bpy.data.objects.remove(orig, do_unlink=True)
        bpy.ops.object.select_all(action="DESELECT")
        new.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_format="GLB")
        phase("export", t)
        emit("done", path=str(out), basecolor=str(out.with_name(out.stem + "_basecolor.png")), stats=stats, phaseMs=PH)
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc()
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

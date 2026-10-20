"""
Đúc lại tóc Pixal3D thành lọn đặc, mượt — Blender (bpy 4.3), chỉ CPU, chạy trong venv của arm `mia-rig`.

    python hairfix.py '{"glb": ".../mesh_reproj.glb", "out": ".../mesh.glb", "dilate": 0.009, "erode": 0.006}'

VÌ SAO: Pixal3D dựng tóc dài thành hàng chục TẤM MỎNG rời (đuôi ngựa của cô bé r05/r07/r10: ảnh back là một
đuôi tóc liền, mesh là chùm dải xé), mép tấm lởm chởm và nhìn xuyên qua khe thấy mặt trong. Remesh mịn hơn
(1024, r07) không chữa: tấm vẫn là tấm.

Cách làm (kích thước theo tỉ lệ chiều cao model):
  1. Mặt tóc = màu atlas tối (luma sRGB < `lumMax` 0,2), ít sắc, thuộc mảng liền lớn (hàn theo vị trí — glTF
     tách đỉnh ở đường nối UV). Mắt, lông mày là mảng nhỏ → bị loại.
  2. MÁI trước mặt (trên cằm `fringeDepth` 0,30 từ đỉnh tóc, phía trước `fringeFront` 0,35 bề sâu tóc, giữa
     ±`fringeWidth` 0,30 bề ngang tóc) giữ nguyên: đóng khe giữa các lọn mái thành rèm che mắt (thử r10, `dilate`
     0,009). Lọn hai bên má thì đúc cả — giữ nửa trên thì thành vết cắt ngang má (r12).
  3. Phần còn lại: tách ra, phép ĐÓNG hình thái — solidify ±`dilate` (0,009) → voxel remesh `voxel` (0,004) hợp
     các tấm sát nhau thành khối → bỏ vụn < 0,4 % đỉnh → co lại `erode` (0,006) theo pháp tuyến → làm mượt.
     0,012/0,008 thì chảy nhão như sáp nến; solidify `even offset` bắn mặt suy biến thành lưỡi dài → tắt, dọn trước.
  4. Bake màu của chính các tấm cũ (vân sợi, bóng) lên UV mới của khối tóc (Cycles, selected → active) — tô một màu
     phẳng thì mất hết vân sợi, "bệt" (r13).
  5. MỘT vật liệu: mọi ảnh của vật liệu thân gấp đôi bề ngang, thân bên trái, tóc bên phải (normal phẳng,
     roughness `roughness` 0,55). Hai vật liệu thì rig nạp bằng trimesh gộp thành atlas mới với UV mới, normal map
     gắn lại sau bind lệch → mảng xám loang trên áo, mặt (r17).

Đầu ra: `out` (GLB, một vật liệu, atlas 2:1), sự kiện `done` với số mặt và màu tóc trung bình.
Giao thức: JSON-lines ra stdout như arm (`step`, `done`, `error`).
"""

from __future__ import annotations

import json
import sys
import time

_PROTO = sys.stdout
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
sys.stdout = sys.stderr

import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from scipy.sparse import coo_matrix  # noqa: E402
from scipy.sparse.csgraph import connected_components  # noqa: E402

T0 = time.time()


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def floats(seq, attr: str, n: int, width: int) -> np.ndarray:
    a = np.empty(n * width, np.float32)
    seq.foreach_get(attr, a)
    return a.reshape(n, width) if width > 1 else a


def ints(seq, attr: str, n: int) -> np.ndarray:
    a = np.empty(n, np.int32)
    seq.foreach_get(attr, a)
    return a


def basecolor_image(mat):
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED" and node.inputs["Base Color"].links:
            src = node.inputs["Base Color"].links[0].from_node
            while src.type != "TEX_IMAGE":
                src = src.inputs[0].links[0].from_node
            return src.image
    raise ValueError("no base colour texture on the mesh")


def face_colours(me) -> np.ndarray:
    """Mean atlas colour (sRGB 0..1) over each face's corners."""
    img = basecolor_image(me.materials[0])
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[..., :3]
    uv = floats(me.uv_layers.active.data, "uv", len(me.loops), 2)
    xi = np.clip((uv[:, 0] % 1) * w, 0, w - 1).astype(int)
    yi = np.clip((uv[:, 1] % 1) * h, 0, h - 1).astype(int)
    ls = ints(me.polygons, "loop_start", len(me.polygons))
    lt = ints(me.polygons, "loop_total", len(me.polygons))
    return np.add.reduceat(px[yi, xi], ls) / lt[:, None]


def hair_faces(me, fc: np.ndarray, height: float, lum_max: float) -> np.ndarray:
    lum = fc @ np.array([0.2126, 0.7152, 0.0722])
    dark = (lum < lum_max) & (fc.max(1) - fc.min(1) < 0.08)
    co = floats(me.vertices, "co", len(me.vertices), 3)
    _, weld = np.unique(np.round(co / (1e-5 * height)).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    lv = ints(me.loops, "vertex_index", len(me.loops))
    lt = ints(me.polygons, "loop_total", len(me.polygons))
    face_of_loop = np.repeat(np.arange(len(me.polygons)), lt)
    sel = dark[face_of_loop]
    nf, nv = len(me.polygons), int(weld.max()) + 1
    graph = coo_matrix(
        (np.ones(int(sel.sum())), (face_of_loop[sel], nf + weld[lv[sel]])), shape=(nf + nv, nf + nv)
    )
    _, comp = connected_components(graph, directed=False)
    lab = np.where(dark, comp[:nf], -1)
    ids, sizes = np.unique(lab[dark], return_counts=True)
    keep = ids[sizes >= max(200, 0.01 * dark.sum())]
    return np.isin(lab, keep) & dark


def apply(obj, kind: str, **settings) -> None:
    m = obj.modifiers.new(kind.lower(), kind)
    for key, value in settings.items():
        setattr(m, key, value)
    bpy.ops.object.modifier_apply(modifier=m.name)


def drop_crumbs(obj, share: float) -> int:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen: set = set()
    kill = []
    total = len(bm.verts)
    for v in bm.verts:
        if v in seen:
            continue
        stack, comp = [v], [v]
        seen.add(v)
        while stack:
            x = stack.pop()
            for e in x.link_edges:
                o = e.other_vert(x)
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
                    comp.append(o)
        if len(comp) < share * total:
            kill.extend(comp)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    return len(kill)


def bake_hair(hobj, src, size: int, height: float):
    """The cards' own colour (strands, sheen) baked onto the fused locks' new UVs."""
    bpy.ops.object.select_all(action="DESELECT")
    hobj.select_set(True)
    bpy.context.view_layer.objects.active = hobj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.003)
    bpy.ops.object.mode_set(mode="OBJECT")

    img = bpy.data.images.new("hair_basecolor", size, size, alpha=False)
    mat = bpy.data.materials.new("hair_bake")
    mat.use_nodes = True
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    mat.node_tree.nodes.active = node
    hobj.data.materials.clear()
    hobj.data.materials.append(mat)

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 1
    bake = sc.render.bake
    bake.use_selected_to_active = True
    # Rays start this far outside the locks and look inwards: the cards lie inside the closed volume.
    bake.cage_extrusion = height * 0.01
    bake.max_ray_distance = height * 0.03
    bake.use_pass_direct = False
    bake.use_pass_indirect = False
    bake.use_pass_color = True
    bake.margin = 8
    bpy.ops.object.select_all(action="DESELECT")
    src.select_set(True)
    hobj.select_set(True)
    bpy.context.view_layer.objects.active = hobj
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True)
    return img


def widen(mat, hair_img, roughness: float) -> None:
    """Every image of the body material doubled in width: the body on the left as it was, the hair on the right.

    One material, not two: the rig loads the GLB with trimesh, which packs two materials into a new atlas with
    new UVs -- and the normal map put back afterwards (rig.py `attach_normal_map`) no longer fits (r17: smeared
    shading all over). The right half of the normal map is flat; of metallic-roughness, `roughness`, no metal.
    """
    hair = np.empty(hair_img.size[0] * hair_img.size[1] * 4, np.float32)
    hair_img.pixels.foreach_get(hair)
    for node in mat.node_tree.nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        img = node.image
        w, h = img.size
        old = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(old)
        old = old.reshape(h, w, 4)
        role = {link.to_node.type for link in node.outputs["Color"].links}
        if "BSDF_PRINCIPLED" in role and any(
            link.to_socket.name == "Base Color" for link in node.outputs["Color"].links
        ):
            right = hair.reshape(h, w, 4)
        elif "NORMAL_MAP" in role:
            right = np.broadcast_to(np.array([0.5, 0.5, 1.0, 1.0], np.float32), old.shape)
        else:
            right = np.broadcast_to(np.array([1.0, roughness, 0.0, 1.0], np.float32), old.shape)
        wide = bpy.data.images.new(img.name + "_wide", 2 * w, h, alpha=False)
        wide.colorspace_settings.name = img.colorspace_settings.name
        wide.pixels.foreach_set(np.concatenate([old, right], axis=1).ravel())
        wide.pack()
        node.image = wide


def shift_uvs(me, offset: float) -> None:
    uv = floats(me.uv_layers.active.data, "uv", len(me.loops), 2)
    uv[:, 0] = offset + 0.5 * uv[:, 0]
    me.uv_layers.active.data.foreach_set("uv", uv.ravel())


def hairfix(job: dict) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["glb"])
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = body.data
    co = floats(me.vertices, "co", len(me.vertices), 3)
    height = float(np.ptp(co[:, 2]))

    fc = face_colours(me)
    hair = hair_faces(me, fc, height, float(job.get("lumMax", 0.2)))
    if not hair.any():
        raise ValueError("no hair found (no large dark region on the atlas)")
    cen = floats(me.polygons, "center", len(me.polygons), 3)
    chin = float(cen[hair, 2].max()) - float(job.get("fringeDepth", 0.30)) * height
    hy = cen[hair, 1]
    ycut = float(hy.min()) + float(job.get("fringeFront", 0.35)) * float(np.ptp(hy))
    hx = cen[hair, 0]
    xmid = 0.5 * float(hx.min() + hx.max())
    xhalf = float(job.get("fringeWidth", 0.30)) * float(np.ptp(hx))
    fringe = hair & (cen[:, 2] > chin) & (cen[:, 1] < ycut) & (np.abs(cen[:, 0] - xmid) < xhalf)
    fused = hair & ~fringe
    colour = fc[hair].mean(0)
    emit("step", stage="select", i=1, of=4, hairFaces=int(hair.sum()), fringeFaces=int(fringe.sum()))

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        f.select = bool(fused[f.index])
    bm.to_mesh(me)
    bm.free()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    hobj = next(o for o in bpy.context.selected_objects if o != body)
    bpy.ops.object.select_all(action="DESELECT")
    hobj.select_set(True)
    bpy.context.view_layer.objects.active = hobj

    bm = bmesh.new()
    bm.from_mesh(hobj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5 * height)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6 * height)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-12], context="FACES")
    bm.to_mesh(hobj.data)
    bm.free()
    # The cards as they were, with their UVs: the bake reads the strands' colour from them.
    src = hobj.copy()
    src.data = hobj.data.copy()
    bpy.context.collection.objects.link(src)

    dilate = float(job.get("dilate", 0.009)) * height
    erode = float(job.get("erode", 0.006)) * height
    apply(hobj, "SOLIDIFY", thickness=2 * dilate, offset=0.0, use_even_offset=False, use_quality_normals=True)
    apply(hobj, "REMESH", mode="VOXEL", voxel_size=float(job.get("voxel", 0.004)) * height)
    crumbs = drop_crumbs(hobj, 0.004)
    if erode > 0:
        apply(hobj, "DISPLACE", direction="NORMAL", mid_level=0.0, strength=-erode)
    smooth = int(job.get("smooth", 12))
    if smooth > 0:
        apply(hobj, "CORRECTIVE_SMOOTH", iterations=smooth, smooth_type="SIMPLE", use_only_smooth=True, factor=0.5)
    emit("step", stage="close", i=2, of=4, faces=len(hobj.data.polygons), crumbVerts=crumbs)

    for poly in hobj.data.polygons:
        poly.use_smooth = True
    hair_out = len(hobj.data.polygons)
    body_mat = me.materials[0]
    size = basecolor_image(body_mat).size[0]
    baked = bake_hair(hobj, src, size, height)
    bpy.data.objects.remove(src, do_unlink=True)
    widen(body_mat, baked, float(job.get("roughness", 0.55)))
    shift_uvs(me, 0.0)
    shift_uvs(hobj.data, 0.5)
    hobj.data.materials.clear()
    hobj.data.materials.append(body_mat)
    emit("step", stage="bake", i=3, of=4, size=size)

    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    hobj.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    bpy.ops.export_scene.gltf(filepath=job["out"], export_format="GLB")
    emit("step", stage="export", i=4, of=4)
    return {
        "out": job["out"],
        "hairFaces": int(hair.sum()),
        "fringeFaces": int(fringe.sum()),
        "fusedFaces": int(fused.sum()),
        "hairOutFaces": hair_out,
        "colour": [round(float(x) * 255) for x in colour],
        "params": {k: job[k] for k in ("dilate", "erode", "voxel", "smooth", "fringeDepth", "fringeFront", "fringeWidth") if k in job},
    }


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        emit("done", **hairfix(job))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit("error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""
Mặt chibi phẳng lại, tai nhỏ lại — Blender (bpy 4.3), chỉ CPU, chạy trong venv của arm `mia-rig`.

    python facefix.py '{"glb": ".../mesh_preface.glb", "out": ".../mesh.glb", "flatten": 40, "ears": 0.65}'

VÌ SAO: Pixal3D dựng mặt chibi (mắt to, mũi một chấm) thành MÕM: mũi nhô nhọn, cằm vát chéo ra sau; cộng hai tai
tròn to vểnh ngang thì "nhìn như con chuột" (người dùng, chibi-martial-girl r43/r44). Mắt, miệng là texture: làm
phẳng hình khối không đụng tới chúng.

Cách làm:
  1. Da = màu atlas sáng, ấm. Mặt = mảng liền lớn nhất của các mặt da quay về phía trước (pháp tuyến −Y sau khi
     nhập glTF) ở nửa trên model; tai = các mảng da nhỏ khác ở cao độ đầu, nằm ngoài bề ngang mặt.
  2. Làm phẳng: Laplace `flatten` vòng chỉ theo trục SÂU (Y) trên đỉnh mặt (hàn theo vị trí — glTF tách đỉnh ở đường
     nối UV), trọng số giảm dần 4 vòng ra mép để không gãy. Chỉ trục Y: bóng mặt nhìn thẳng (X, Z) giữ nguyên.
  3. Tai: co về điểm bám (đỉnh gần trục đầu nhất) theo hệ số `ears`.

Đầu ra: `out` (GLB, vật liệu và UV như cũ), sự kiện `done` với số đỉnh đã dời và độ nhô của mũi trước/sau.
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
import numpy as np  # noqa: E402
from scipy.sparse import coo_matrix  # noqa: E402
from scipy.sparse.csgraph import connected_components  # noqa: E402

T0 = time.time()


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def arr(seq, attr: str, n: int, width: int, dtype=np.float32) -> np.ndarray:
    a = np.empty(n * width, dtype)
    seq.foreach_get(attr, a)
    return a.reshape(n, width) if width > 1 else a


def basecolor_pixels(mat) -> np.ndarray:
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED" and node.inputs["Base Color"].links:
            src = node.inputs["Base Color"].links[0].from_node
            while src.type != "TEX_IMAGE":
                src = src.inputs[0].links[0].from_node
            w, h = src.image.size
            px = np.empty(w * h * 4, np.float32)
            src.image.pixels.foreach_get(px)
            return px.reshape(h, w, 4)[..., :3]
    raise ValueError("no base colour texture on the mesh")


def facefix(job: dict) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["glb"])
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = obj.data
    nv, nf, nl = len(me.vertices), len(me.polygons), len(me.loops)
    co = arr(me.vertices, "co", nv, 3).astype(np.float64)
    height = float(np.ptp(co[:, 2]))
    zmin = float(co[:, 2].min())

    # face colours from the atlas (sRGB values)
    px = basecolor_pixels(me.materials[0])
    th, tw = px.shape[:2]
    uv = arr(me.uv_layers.active.data, "uv", nl, 2)
    lc = px[np.clip((uv[:, 1] % 1) * th, 0, th - 1).astype(int), np.clip((uv[:, 0] % 1) * tw, 0, tw - 1).astype(int)]
    ls = arr(me.polygons, "loop_start", nf, 1, np.int32)
    lt = arr(me.polygons, "loop_total", nf, 1, np.int32)
    fc = np.add.reduceat(lc, ls) / lt[:, None]
    lum = fc @ np.array([0.2126, 0.7152, 0.0722])
    skin = (lum > 0.6) & (fc[:, 0] >= fc[:, 2]) & ((fc.max(1) - fc.min(1)) < 0.35)
    fn = arr(me.polygons, "normal", nf, 3)
    cen = arr(me.polygons, "center", nf, 3)
    upper = cen[:, 2] > zmin + 0.55 * height

    # weld by position
    _, weld = np.unique(np.round(co / (1e-5 * height)).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.ravel()
    nw = int(weld.max()) + 1
    lv = arr(me.loops, "vertex_index", nl, 1, np.int32)
    face_of_loop = np.repeat(np.arange(nf), lt)

    def components(mask: np.ndarray) -> np.ndarray:
        sel = mask[face_of_loop]
        g = coo_matrix((np.ones(int(sel.sum())), (face_of_loop[sel], nf + weld[lv[sel]])), shape=(nf + nw, nf + nw))
        _, comp = connected_components(g, directed=False)
        return np.where(mask, comp[:nf], -1)

    front_skin = skin & upper & (fn[:, 1] < -0.3)
    lab = components(front_skin)
    ids, counts = np.unique(lab[front_skin], return_counts=True)
    if not len(ids):
        raise ValueError("no front-facing skin found")
    face = lab == ids[np.argmax(counts)]
    fx = cen[face, 0]
    emit("step", stage="select", i=1, of=3, faceFaces=int(face.sum()))

    # welded positions, edges
    wpos = np.zeros((nw, 3))
    np.add.at(wpos, weld, co)
    wpos /= np.bincount(weld, minlength=nw)[:, None]
    nxt = np.empty(nl, np.int64)
    starts = np.repeat(ls, lt)
    offs = np.arange(nl) - starts
    nxt = starts + (offs + 1) % np.repeat(lt, lt)
    a, b = weld[lv], weld[lv[nxt]]
    edges = np.unique(np.sort(np.stack([a, b], 1), 1), axis=0)
    edges = edges[edges[:, 0] != edges[:, 1]]
    adj = coo_matrix((np.ones(2 * len(edges)), (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]])), shape=(nw, nw)).tocsr()
    deg = np.asarray(adj.sum(1)).ravel()

    # The muzzle. Along the centre line a Pixal3D chibi face is fairly flat; ACROSS it, the mouth and chin rows
    # fall back fast (r43: 0.037*H behind the centre at 0.08*H off it) while the eye row stays flat -- a wedge,
    # read as a mouse. Each lower-face row is given the eye row's horizontal curve, anchored at its own sides
    # (|x| = `half`), so the centre moves back and the cheeks stay where they are.
    xc = float(np.median(co[co[:, 2] > zmin + 0.55 * height, 0]))
    hairish = lum < 0.35
    vhair = np.zeros(nw, bool)
    np.logical_or.at(vhair, weld[lv], hairish[face_of_loop])
    vskin = np.zeros(nw, bool)
    np.logical_or.at(vskin, weld[lv], (skin & upper & (fc[:, 0] - fc[:, 2] > 0.02))[face_of_loop])
    half = float(job.get("half", 0.09)) * height
    rel = np.abs(wpos[:, 0] - xc)
    mid = vskin & (rel < 0.01 * height)
    zs = wpos[:, 2]

    def front_depth(mask, z0, z1):
        m = mask & (zs >= z0) & (zs < z1)
        return float(wpos[m, 1].min()) if m.any() else np.nan

    # chin = the neck crease (least forward centre depth) between 0.55 and 0.70 H; eye row = chin + `eyeAbove`
    bins = np.arange(zmin + 0.55 * height, zmin + 0.70 * height, 0.01 * height)
    prof = np.array([front_depth(mid, z, z + 0.01 * height) for z in bins])
    zchin = float(bins[np.nanargmax(prof)] + 0.01 * height)
    zeye = zchin + float(job.get("eyeAbove", 0.13)) * height
    # the eye row's horizontal curve: front depth at |x| (both sides averaged), relative to the anchor at `half`
    xs = np.linspace(0, half, 10)
    def row_curve(z0, z1):
        out = []
        for x in xs:
            m = vskin & ~vhair & (np.abs(rel - x) < 0.006 * height)
            out.append(front_depth(m, z0, z1))
        return np.array(out)
    eye = row_curve(zeye - 0.02 * height, zeye + 0.02 * height)
    if np.isnan(eye).any():
        good = ~np.isnan(eye)
        eye = np.interp(xs, xs[good], eye[good])
    ecurve = eye - eye[-1]  # 0 at the anchor, negative (forward) toward the centre

    region = vskin & ~vhair & (zs > zchin) & (zs < zeye) & (rel < half)
    # only the front layer of the head, not the back of a two-layer shell
    region &= wpos[:, 1] < float(np.nanmin(prof)) + 0.08 * height
    fv = np.nonzero(region)[0]
    # anchor depth per row: the front depth at |x| ~ half on that row
    rows = np.arange(zchin, zeye, 0.01 * height)
    anchor = np.array([front_depth(vskin & ~vhair & (np.abs(rel - half) < 0.008 * height), z, z + 0.01 * height) for z in rows])
    good = ~np.isnan(anchor)
    anc = np.interp(zs[fv], rows[good] + 0.005 * height, anchor[good])
    target = anc + np.interp(rel[fv], xs, ecurve)
    # weight: full in the middle rows, fading to the chin and eye rows and toward the sides
    t = (zs[fv] - zchin) / (zeye - zchin)
    wz = np.clip(np.minimum(t, 1 - t) / 0.25, 0, 1)
    wx = np.clip((half - rel[fv]) / (0.3 * half), 0, 1)
    wv = wz * wx
    pull = np.clip(target - wpos[fv, 1], 0, None)  # only move what stands in front of the target
    before = float(pull.max() / height)
    wpos[fv, 1] += wv * pull
    w = np.zeros(nw)
    w[fv] = wv
    y = wpos[:, 1].copy()
    for _ in range(int(job.get("flatten", 15))):
        avg = (adj @ y) / np.maximum(deg, 1)
        y = y + 0.5 * (w > 0) * (avg - y)
    wpos[:, 1] = y
    after = float(np.clip(target - wpos[fv, 1], 0, None).max() / height)
    tip = fv[np.argmax(pull)] if len(fv) else 0
    emit("step", stage="flatten", i=2, of=3, chin=round((zchin - zmin) / height, 3), eye=round((zeye - zmin) / height, 3), region=len(fv), noseFrom=round(before, 4), noseTo=round(after, 4))

    # ears: skin reaching further out than the face does at the same height (r43: face |x| <= ~0.10*H, ears to
    # 0.147*H at 0.66-0.76 H), on the side of the head. They join the face's skin, so they are cut by position:
    # every skin vertex past `earX`, scaled by `ears` toward the point where it leaves that plane.
    ear_scale = float(job.get("ears", 0.65))
    ears = []
    if ear_scale < 1:
        ear_x = float(job.get("earX", 0.105)) * height
        yfront = float(np.nanmin(prof))
        for side in (-1, 1):
            m = vskin & ~vhair & (side * (wpos[:, 0] - xc) > ear_x - 0.01 * height) & (zs > zchin) & (zs < zeye + 0.03 * height)
            m &= (wpos[:, 1] > yfront + 0.02 * height) & (wpos[:, 1] < yfront + 0.16 * height)
            ev = np.nonzero(m)[0]
            if len(ev) < 20:
                continue
            out = side * (wpos[ev, 0] - xc) - ear_x  # how far past the plane
            k = np.clip((out + 0.01 * height) / (0.02 * height), 0, 1)  # feather across the plane
            root = np.array([xc + side * ear_x, wpos[ev, 1].mean(), wpos[ev, 2].mean()])
            scaled = root + (wpos[ev] - root) * ear_scale
            wpos[ev] = wpos[ev] + k[:, None] * (scaled - wpos[ev])
            ears.append({"side": side, "verts": len(ev), "reach": round(float(out.max() / height), 3)})
    emit("step", stage="ears", i=3, of=3, ears=ears)

    if job.get("debugMark"):
        # paint the region red on the atlas pixels of its faces' corners (debug only)
        img = None
        for node in me.materials[0].node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.outputs["Color"].links and node.outputs["Color"].links[0].to_socket.name == "Base Color":
                img = node.image
        full = np.empty(tw * th * 4, np.float32)
        img.pixels.foreach_get(full)
        full = full.reshape(th, tw, 4)
        sel = region[weld[lv]]
        full[np.clip((uv[sel, 1] % 1) * th, 0, th - 1).astype(int), np.clip((uv[sel, 0] % 1) * tw, 0, tw - 1).astype(int), :3] = (1, 0, 0)
        img.pixels.foreach_set(full.ravel())
        img.pack()
    me.vertices.foreach_set("co", wpos[weld].astype(np.float32).ravel())
    me.update()
    bpy.ops.export_scene.gltf(filepath=job["out"], export_format="GLB")
    return {"out": job["out"], "region": len(fv), "noseFrom": round(before, 4), "noseTo": round(after, 4), "ears": ears}


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        emit("done", **facefix(job))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc()
        emit("error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

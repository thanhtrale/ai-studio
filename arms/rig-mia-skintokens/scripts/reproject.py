"""
Chiếu màu ảnh vào lên atlas base color của mesh Pixal3D — chạy bằng python của arm `mia-rig` (trimesh + embree + cv2).

    python reproject.py '{"glb": ".../mesh_pixal.glb", "out": ".../mesh.glb", "views": {"front": ".../mesh_views/front.png", ...}}'

VÌ SAO: texture Pixal3D là xổ số — trên ref cô bé (sheet r38) 1/18 lượt có mặt đạt; lượt đạt vẫn còn trâm sai màu,
vệt màu lạ trên tóc, hồng tối 15–20%. Hình khối thì ổn định. Pixal3D dựng mesh KHỚP ĐIỂM ẢNH với từng góc vào
(`mesh_views/*.png` là đúng crop model thấy), nên màu thật nằm sẵn trong ảnh vào — chỉ cần chiếu ngược lên.

Cách làm:
  1. Raster atlas UV → mỗi texel một vị trí 3D + pháp tuyến.
  2. Mỗi góc: khớp camera bằng IoU bóng (phương vị đã biết ±180°, trực giao hoặc phối cảnh), mặt nạ = điểm không đen.
  3. Texel thấy được từ camera (tia embree, không vướng mặt nào) và quay mặt về camera → lấy màu ảnh vào.
     Chi tiết nhỏ của mesh (sợi tóc, mép má) lệch vài px so với ảnh vào → optical flow DIS từ ảnh texture CŨ
     nhìn từ camera đó sang ảnh vào, rồi lấy mẫu ở vị trí đã kéo (≤ 15 px).
  4. Texel không góc nào thấy (bên phải, đỉnh đầu, khe): ánh xạ màu cũ → màu ảnh vào bằng láng giềng gần trong
     không gian màu cũ (affine toàn cục từng đẻ trâm xanh lá). Màu cũ xa mọi mẫu → giữ nguyên.
  5. Tóc (mảng tối, ít sắc, lớn liền nhau — theo màu đã chiếu): giảm sắc độ còn `hairChroma` (0,25) — tóc tối ngả tím của ref
     lên 3D đọc thành ám hồng (r62); dời độ sáng trung vị về `hairLum` (0,13) — tóc sáng như ref thành xám xi măng (r65).
  6. Loang màu ra mép đảo UV (không loang thì lấy mẫu song tuyến chạm nền đen của atlas → vệt nứt trên mặt).
  7. Thay ĐÚNG ảnh base color trong GLB gốc (byte), giữ nguyên normal/AO/roughness, TANGENT, mọi thứ khác.

Đầu ra: `out` (GLB), `<out stem>_basecolor.png`, sự kiện `done` với số đo từng góc (iou, flow, texel dùng).
"""

from __future__ import annotations

import io
import json
import math
import struct
import sys
import time

_PROTO = sys.stdout
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
sys.stdout = sys.stderr

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402
from trimesh.ray.ray_pyembree import RayMeshIntersector  # noqa: E402

T0 = time.time()
AZ = {"front": 0, "left": 90, "back": 180, "right": 270}


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def raster_uv(UV, F, TW, TH):
    """Atlas → (ty, tx, mặt, toạ độ trọng tâm). trimesh đọc UV glTF với v hướng lên → hàng = (1-v)·H."""
    P = np.stack([UV[:, 0] * TW - 0.5, (1 - UV[:, 1]) * TH - 0.5], 1)
    fid = np.full((TH, TW), -1, np.int32)
    tri = P[F]
    lo = np.clip(np.floor(tri.min(1)).astype(int), 0, [TW - 1, TH - 1])
    hi = np.clip(np.ceil(tri.max(1)).astype(int), 0, [TW - 1, TH - 1])
    span = hi - lo + 1
    K = 12
    small = (span[:, 0] <= K) & (span[:, 1] <= K)
    oy, ox = np.mgrid[0:K, 0:K]
    ox, oy = ox.ravel(), oy.ravel()

    def bary(fi, X, Y):
        a, b, c = tri[fi, 0], tri[fi, 1], tri[fi, 2]
        d = (b[..., 1] - c[..., 1]) * (a[..., 0] - c[..., 0]) + (c[..., 0] - b[..., 0]) * (a[..., 1] - c[..., 1])
        d = np.where(np.abs(d) < 1e-12, 1e-12, d)
        if X.ndim == 2:
            a, b, c, d = a[:, None], b[:, None], c[:, None], d[:, None]
        l1 = ((b[..., 1] - c[..., 1]) * (X - c[..., 0]) + (c[..., 0] - b[..., 0]) * (Y - c[..., 1])) / d
        l2 = ((c[..., 1] - a[..., 1]) * (X - c[..., 0]) + (a[..., 0] - c[..., 0]) * (Y - c[..., 1])) / d
        return l1, l2, 1 - l1 - l2

    idx = np.nonzero(small)[0]
    for s in range(0, len(idx), 20000):
        fi = idx[s:s + 20000]
        X = lo[fi, 0, None] + ox[None]
        Y = lo[fi, 1, None] + oy[None]
        l1, l2, l3 = bary(fi, X, Y)
        e = -1e-3
        ok = (l1 >= e) & (l2 >= e) & (l3 >= e) & (X <= hi[fi, 0, None]) & (Y <= hi[fi, 1, None])
        r, k = np.nonzero(ok)
        fid[Y[r, k], X[r, k]] = fi[r]
    for f in np.nonzero(~small)[0]:
        cv2.fillPoly(fid, [np.round(tri[f]).astype(np.int32)], int(f))
    ty, tx = np.nonzero(fid >= 0)
    ff = fid[ty, tx]
    L = np.clip(np.stack(bary(ff, tx.astype(np.float64), ty.astype(np.float64)), 1), 0, 1)
    L /= L.sum(1, keepdims=True)
    return fid >= 0, ty, tx, ff, L


def cam_axes(az):
    r = math.radians(az)
    return np.array([math.sin(r), 0, math.cos(r)]), np.array([math.cos(r), 0, -math.sin(r)])


def project(p, az, dist, sc, cx, cy):
    """→ (px, py) trong ảnh góc; dist=None là trực giao. Camera nhìn về gốc toạ độ (Pixal3D đặt mesh giữa khung)."""
    c, rt = cam_axes(az)
    u, v, z = p @ rt, p[:, 1], p @ c
    k = 1.0 if dist is None else dist / (dist - z)
    return cx + sc * u * k, cy - sc * v * k


def fit_camera(V, F, mask, az):
    ys, xs = np.nonzero(mask)
    best = None
    sv = V[::3]
    for dist in (None, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0):
        u, v = project(sv, az, dist, 1.0, 0.0, 0.0)
        sc = (ys.max() - ys.min()) / (v.max() - v.min())
        cx = (xs.max() + xs.min()) / 2 - sc * (u.max() + u.min()) / 2
        cy = (ys.max() + ys.min()) / 2 + sc * (v.max() + v.min()) / 2
        px, py = project(V, az, dist, sc, cx, cy)
        sil = np.zeros(mask.shape, np.uint8)
        cv2.fillPoly(sil, list(np.stack([px, py], 1)[F].round().astype(np.int32)), 1)
        sil = sil.astype(bool)
        iou = (sil & mask).sum() / max((sil | mask).sum(), 1)
        if best is None or iou > best[0]:
            best = (float(iou), dist, float(sc), float(cx), float(cy))
    return best


def colour_err(pos, nrm, old, img, mask, az, fit):
    """Sai khác màu trung bình giữa texture cũ của Pixal3D và ảnh góc, nếu camera đặt ở `az` (không xét che khuất).
    Dùng khi bóng trước/sau gần như đối xứng: nhân vật tỉ lệ người thật, tóc bob, A-pose — IoU hai phía chênh
    < 0,01, jade-hanfu-girl r03 chọn az 180 cho ảnh MẶT TRƯỚC, chiếu mặt lên gáy và gáy lên mặt."""
    _, dist, sc, cx, cy = fit
    c, _ = cam_axes(az)
    sel = np.nonzero(nrm[::7] @ c > 0.3)[0] * 7
    px, py = project(pos[sel], az, dist, sc, cx, cy)
    S = img.shape[0]
    xi, yi = px.round().astype(int), py.round().astype(int)
    inb = (xi >= 0) & (xi < S) & (yi >= 0) & (yi < S)
    sel, xi, yi = sel[inb], xi[inb], yi[inb]
    keep = mask[yi, xi]
    if not keep.any():
        return 1.0
    return float(np.abs(old[sel[keep]] - img[yi[keep], xi[keep]]).mean())


def replace_basecolor(src: str, dst: str, png: bytes) -> None:
    """Thay bytes ảnh base color (vật liệu đầu) trong GLB, dời offset các bufferView. Không đụng thứ gì khác."""
    b = open(src, "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    bo = 20 + jl
    bl = struct.unpack("<I", b[bo:bo + 4])[0]
    binb = b[bo + 8:bo + 8 + bl]
    ti = j["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    bvi = j["images"][j["textures"][ti]["source"]]["bufferView"]
    views = j["bufferViews"]
    order = sorted(range(len(views)), key=lambda i: views[i].get("byteOffset", 0))
    out = bytearray()
    for i in order:
        v = views[i]
        data = png if i == bvi else binb[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
        while len(out) % 4:
            out.append(0)
        v["byteOffset"] = len(out)
        v["byteLength"] = len(data)
        out += data
    while len(out) % 4:
        out.append(0)
    j["buffers"][0]["byteLength"] = len(out)
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(dst, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(out), 0x004E4942) + bytes(out))


def reproject(job: dict) -> dict:
    src, dst = job["glb"], job["out"]
    flow_on = job.get("flow", True)
    scene = trimesh.load(src)
    g = list(scene.geometry.values())[0]
    V = g.vertices.view(np.ndarray).astype(np.float64)
    F = g.faces.view(np.ndarray)
    UV = g.visual.uv.view(np.ndarray).astype(np.float64)
    VN = g.vertex_normals.view(np.ndarray)
    tex = np.asarray(g.visual.material.baseColorTexture.convert("RGB")).astype(np.float32) / 255
    TH, TW = tex.shape[:2]
    cover, ty, tx, ff, L = raster_uv(UV, F, TW, TH)
    pos = (V[F[ff]] * L[..., None]).sum(1)
    nrm = (VN[F[ff]] * L[..., None]).sum(1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    old = tex[ty, tx]
    emit("step", stage="raster", i=1, of=5)

    ray = RayMeshIntersector(g)
    H = V[:, 1].max() - V[:, 1].min()
    acc = np.zeros((len(ty), 3))
    wsum = np.zeros(len(ty))
    stats: dict[str, dict] = {}
    # Mesh Pixal3D có thể quay 180° — khi đó MỌI góc cùng quay, nên chọn MỘT lần cho cả bộ (flip 0 hay 180), không
    # từng góc: jade-hanfu-girl r03 (tỉ lệ người thật, tóc bob) — bóng trước/sau gần đối xứng, IoU riêng góc trước
    # chọn az 180 (0,92 vs 0,89) → mặt lấy màu gáy. Bóng góc nghiêng thì bất đối xứng (0,96) và kéo cả bộ về đúng.
    loaded = []
    for name, path in job["views"].items():
        if name not in AZ:
            continue
        img = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255
        full = img.max(2) > 0.02
        full = cv2.morphologyEx(full.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)).astype(bool)
        inner = cv2.erode(full.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
        fits = {flip: fit_camera(V, F, full, (AZ[name] + flip) % 360) for flip in (0, 180)}
        loaded.append((name, img, full, inner, fits))
    total = {flip: sum(v[4][flip][0] for v in loaded) for flip in (0, 180)}
    flip = max(total, key=total.get)
    side: dict = {"by": "iou", "iou": {k: round(v, 3) for k, v in total.items()}}
    # Tổng IoU vẫn sát nhau (mọi góc đều đối xứng) → chọn theo màu texture cũ (mặt là da, gáy là tóc).
    if abs(total[0] - total[180]) < 0.02 * len(loaded):
        err = {f: sum(colour_err(pos, nrm, old, v[1], v[3], (AZ[v[0]] + f) % 360, v[4][f]) for v in loaded) for f in (0, 180)}
        flip = min(err, key=err.get)
        side = {"by": "colour", "iou": side["iou"], "err": {k: round(v, 3) for k, v in err.items()}}
    flip_stats = {"deg": flip, **side}
    for vi, (name, img, full, inner, fits) in enumerate(loaded):
        S = img.shape[0]
        az = (AZ[name] + flip) % 360
        iou, dist, sc, cx, cy = fits[flip]
        c, _ = cam_axes(az)
        if dist is None:
            dirs = np.repeat(c[None], len(ty), 0)
        else:
            dirs = c[None] * dist - pos
            dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        facing = (nrm * dirs).sum(1)
        ci = np.nonzero(facing > 0.1)[0]
        hit = np.zeros(len(ci), bool)
        org = pos[ci] + dirs[ci] * (0.002 * H)
        for s in range(0, len(ci), 500000):
            hit[s:s + 500000] = ray.intersects_any(org[s:s + 500000], dirs[ci[s:s + 500000]])
        vis = np.zeros(len(ty), bool)
        vis[ci[~hit]] = True
        px, py = project(pos, az, dist, sc, cx, cy)
        inb = (px >= 0) & (px < S - 1) & (py >= 0) & (py < S - 1)
        xi, yi = np.clip(px.round().astype(int), 0, S - 1), np.clip(py.round().astype(int), 0, S - 1)
        ok = vis & inb & inner[yi, xi]
        st = {"az": az, "dist": dist, "iou": round(iou, 3)}
        if flow_on:
            sel = vis & inb & full[yi, xi]
            accI = np.zeros((S, S, 3), np.float32)
            cntI = np.zeros((S, S), np.float32)
            np.add.at(accI, (yi[sel], xi[sel]), old[sel])
            np.add.at(cntI, (yi[sel], xi[sel]), 1)
            R = (accI / np.maximum(cntI, 1)[..., None] * 255).astype(np.uint8)
            R = cv2.inpaint(R, ((cntI == 0) & full).astype(np.uint8), 3, cv2.INPAINT_TELEA)
            R[~full] = 0
            fl = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM).calc(
                cv2.cvtColor(R, cv2.COLOR_RGB2GRAY), cv2.cvtColor((img * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY), None)
            mag = np.linalg.norm(fl, axis=2)
            big = mag > 15
            fl[big] *= (15 / mag[big])[:, None]
            st["flowPx"] = {"median": round(float(np.median(mag[full])), 1), "p95": round(float(np.percentile(mag[full], 95)), 1)}
            px = px + fl[yi, xi, 0]
            py = py + fl[yi, xi, 1]
            # flow có thể kéo ra nền ngoài bóng → soát mặt nạ lại ở vị trí mới
            ok &= inner[np.clip(py.round().astype(int), 0, S - 1), np.clip(px.round().astype(int), 0, S - 1)]
        w = np.clip((facing - 0.25) / 0.45, 0, 1) ** 2 * ok * (1.0 if name == "front" else 0.6)
        x0 = np.clip(np.floor(px).astype(int), 0, S - 2)
        y0 = np.clip(np.floor(py).astype(int), 0, S - 2)
        fx = np.clip(px - x0, 0, 1)[:, None]
        fy = np.clip(py - y0, 0, 1)[:, None]
        col = img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy
        acc += w[:, None] * col
        wsum += w
        st["texels"] = int((w > 0).sum())
        stats[name] = st
        emit("step", stage=f"view-{name}", i=2 + vi, of=5)

    proj = acc / np.maximum(wsum, 1e-9)[:, None]
    seen = np.nonzero(wsum > 0.8)[0]
    if len(seen) < 1000:
        raise RuntimeError(f"only {len(seen)} texels seen by the input views — camera fit failed")
    seen = np.random.default_rng(0).choice(seen, min(len(seen), 200000), replace=False)
    kd = cKDTree(old[seen])
    need = np.nonzero(wsum < 1)[0]
    dd, nn = kd.query(old[need], k=16, workers=-1)
    wk = 1 / (dd + 0.02)
    mapped = (proj[seen][nn] * wk[..., None]).sum(1) / wk.sum(1, keepdims=True)
    far = np.clip((dd[:, 0] - 0.08) / 0.1, 0, 1)[:, None]
    corr = old.copy()
    corr[need] = (1 - far) * mapped + far * old[need]
    W = np.clip(wsum, 0, 1)[:, None]
    outtex = tex.copy()
    newc = W * proj + (1 - W) * corr
    # Tóc: ref anime hay tô tóc tối ngả tím/hồng (cô bé: RGB ~87,75,79, hue 335°) — lên 3D, sáng phẳng, đọc thành
    # tóc ÁM HỒNG (người dùng chê r62). Vùng tóc = mảng tối LỚN liền nhau (đồng tử, mi là mảng nhỏ
    # nằm giữa da → không dính); ở đó giữ độ sáng chiếu được, giảm sắc độ.
    desat = float(job.get("hairChroma", 0.25))
    hair_stats = None
    if desat < 1:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        nf = len(F)
        # theo màu MỚI (texture cũ có lượt tóc chỗ đen chỗ nâu — r64): tối và ít sắc
        mx, mn = newc.max(1), newc.min(1)
        # HOẶC tối trên texture cũ: chỗ Pixal3D tô tóc mà chiếu lệch ra màu da/sáng (mảng "mốc trắng" r65)
        is_dark = ((mx < 0.5) & ((mx - mn) < 0.18)) | (old.max(1) < 0.12)
        dark_frac = np.bincount(ff, weights=is_dark.astype(float), minlength=nf) / np.maximum(np.bincount(ff, minlength=nf), 1)
        dark = dark_frac > 0.5
        # atlas UV tách đỉnh ở mép đảo → nối lại theo vị trí, không thì mỗi đảo UV là một mảng riêng
        gm = trimesh.Trimesh(V, F, process=False)
        gm.merge_vertices(merge_tex=True, merge_norm=True)
        adj = gm.face_adjacency
        adj = adj[dark[adj[:, 0]] & dark[adj[:, 1]]]
        n_cc, lab = connected_components(coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(nf, nf)), directed=False)
        sizes = np.bincount(lab[dark], minlength=n_cc)
        big = sizes > 0.02 * max(int(dark.sum()), 1)
        # Tóc mọc từ đỉnh đầu: chỉ mảng tối chạm tới 8 % trên cùng của chiều cao. Không có điều kiện này, mọi mảng
        # tối lớn đều bị coi là tóc — quần navy (inosuke-boar-mask r02), cổ lông xám của cô gái tóc bạc
        # (fox-ear-girl r02, cả hai bản) thành đen. Tóc sáng (bạc, trắng) không tối → không mảng nào chạm đỉnh → bỏ qua.
        fy = V[F].mean(1)[:, 1]
        top = np.full(n_cc, -np.inf)
        np.maximum.at(top, lab[dark], fy[dark])
        big &= top >= V[:, 1].max() - 0.08 * H
        hair_f = dark & big[lab]
        emit("step", stage="hair", i=4, of=5, darkFaces=int(dark.sum()), parts=int(big.sum()), top=[int(x) for x in np.sort(sizes)[::-1][:5]])
        ht = hair_f[ff]
        if not ht.any():
            hair_stats = {"faces": 0, "texels": 0, "note": "no dark region reaches the top of the head"}
        else:
            c = newc[ht]
            grey = c.mean(1, keepdims=True)
            # Độ sáng: ảnh vào (đã tách nền, tóc anime tô sáng) cho tóc trung vị ~0,37 → lên 3D thành XÁM XI MĂNG, đốm
            # sáng thành mốc trắng (người dùng chê r65). Tóc Pixal3D của cậu bé: trung vị 0,12. Dời trung vị về
            # `hairLum`, giữ chênh lệch sợi, chặn đỉnh 0,3.
            target = float(job.get("hairLum", 0.13))
            med = float(np.median(grey))
            dv = grey - med
            dv[dv > 0.15] = 0  # điểm sáng lạc (da/nền chiếu lệch lên sợi tóc) → về màu tóc
            g2 = np.clip(target + dv, 0.02, 0.3)
            newc[ht] = g2 + (c - grey) * desat * (g2 / np.maximum(grey, 1e-3))
            hair_stats = {"faces": int(hair_f.sum()), "texels": int(ht.sum()), "chroma": desat, "lumFrom": round(med, 3), "lumTo": target,
                          "meanRGB": [int(x) for x in (newc[ht].mean(0) * 255).round()]}
    # ai-studio: the sheet is flat anime colour, drawn LIGHTER than the original (chibi-martial-girl r05:
    # pink L 75 after projection vs 71 in the original, 67 on Pixal3D's own atlas; non-hair median 72 vs 62)
    # and with no shading -- in a viewer that read as washed white and chalky, "a plaster statue". So the
    # lightness is mixed back towards Pixal3D's (`lumMix`, 0 = the old behaviour) while hue and chroma stay
    # the sheet's. Only where the two roughly agree: where they differ a lot (eyes, a streak Pixal3D painted
    # across the face) the projection is what fixes the texture, and it is kept as it is. Hair is left out --
    # its lightness was set on purpose above.
    lum_mix = float(job.get("lumMix", 0.5))
    lum_stats = None
    if lum_mix > 0:
        lab_new = cv2.cvtColor(newc.reshape(-1, 1, 3).astype(np.float32), cv2.COLOR_RGB2LAB).reshape(-1, 3)
        lab_old = cv2.cvtColor(old.reshape(-1, 1, 3).astype(np.float32), cv2.COLOR_RGB2LAB).reshape(-1, 3)
        d_l = np.abs(lab_new[:, 0] - lab_old[:, 0])
        k = lum_mix * np.clip(1 - d_l / 20.0, 0, 1)
        if hair_stats is not None:
            k[ht] = 0
        before = float(np.median(lab_new[:, 0]))
        lab_new[:, 0] = (1 - k) * lab_new[:, 0] + k * lab_old[:, 0]
        newc = np.clip(cv2.cvtColor(lab_new.reshape(-1, 1, 3), cv2.COLOR_LAB2RGB).reshape(-1, 3), 0, 1)
        lum_stats = {"mix": lum_mix, "medianLFrom": round(before, 1), "medianLTo": round(float(np.median(lab_new[:, 0])), 1),
                     "mixedShare": round(float((k > 0.05).mean()), 3)}
    outtex[ty, tx] = newc
    img8 = (outtex * 255).round().astype(np.uint8)
    cov = cover.copy()
    for _ in range(6):
        blur = cv2.blur(img8.astype(np.float32) * cov[..., None], (3, 3))
        cnt = cv2.blur(cov.astype(np.float32), (3, 3))
        ring = (~cov) & (cnt > 0)
        img8[ring] = (blur[ring] / cnt[ring][:, None]).round().astype(np.uint8)
        cov |= ring
    buf = io.BytesIO()
    Image.fromarray(img8).save(buf, "PNG")
    replace_basecolor(src, dst, buf.getvalue())
    bc = str(dst)[:-4] + "_basecolor.png"
    open(bc, "wb").write(buf.getvalue())
    emit("step", stage="write", i=5, of=5)
    return {"path": dst, "basecolor": bc, "views": stats, "flip": flip_stats,
            "hair": hair_stats, "lum": lum_stats, "texels": {"total": int(len(ty)), "projected": int((wsum > 0).sum()), "mappedFar": int((far[:, 0] > 0.5).sum())}}


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        emit("done", **reproject(job))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit("error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

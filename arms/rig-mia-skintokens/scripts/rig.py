"""
Arm auto-rig: mesh người (GLB) → khung xương Mixamo 65 bone + trọng số skin + clip Mixamo.

Dùng Make-It-Animatable v2 (nhánh `v2`, code ở `runtime.dir`) làm THƯ VIỆN: import `app_v2` rồi gọi
thẳng bốn bước của nó (`prepare_input` → `preprocess` → `infer` → `vis`), bỏ lớp Gradio. Phần Blender
không đi qua `vis_blender` của nó vì hai chỗ không hợp:
  - nó đổi FBX → GLB bằng `util/FBX2glTF` (binary Linux), ở đây xuất GLB thẳng từ bpy;
  - nó nạp ĐÚNG MỘT clip, và nhánh retarget (Auto-Rig Pro) XOÁ mọi action khác — ở đây cần nhiều
    clip trong một file, mỗi clip một NLA track.

Vào (một dòng JSON trên stdin):
  mesh         đường GLB (tuyệt đối)
  out          thư mục ra
  animations   [{name, path}] — FBX Mixamo, chỉ khung xương
  restPose     "A-pose" | "T-pose" | null — tư thế của mesh vào; quyết bộ phận nào được xoay về T-pose.
               "T-pose" = bỏ hết pose dự đoán: mesh giữ nguyên dáng vào làm tư thế nghỉ
  noFingers    bỏ xương ngón (gộp trọng số vào bàn tay)
  retarget     dùng Auto-Rig Pro để retarget (mặc định false: cùng tên bone mixamorig nên gán thẳng)
  inplace      khoá dịch chuyển gốc (clip chạy không chạy khỏi khung)
  weightFix    bỏ trọng số rò giữa các chuỗi tay/chân/thân (mặc định true) — xem `limb_weight_fix`
  headTarget   tỉ lệ đầu/chiều cao đưa về trước khi dự đoán (mặc định 0.2; 0 = tắt) — xem `HeadShrink`
  seed         seed lấy mẫu điểm của MIA (mặc định 0) — cùng mesh + seed thì cùng dự đoán
  prep         dọn mesh trước khi rig (mặc định true; dict = tham số prep.py: voxel, faces, minPart, hairCut) — MIA và
               bone heat chạy trên bản một vỏ kín, trọng số chép về mesh gốc (giữ texture). Xem prep.py
  predFrom     đường `mia_raw.pkl` của một lượt trước: dùng lại dự đoán, bỏ MIA — để so lớp vá trên CÙNG dự đoán
  skinFrom     đường `st_out.npz` của một lượt trước (cùng predFrom): dùng lại trọng số SkinTokens — nó cũng không tất định
  weights      "skintokens" (mặc định; thiếu venv thì lùi về "heat") | "heat" | "mia" — nguồn trọng số — nguồn trọng số skin; khớp luôn của MIA. Xem `heat_weights`
  armSmooth    số vòng mượt trọng số ở vùng tay áo hàn vào thân/hông (mặc định 150; 0 = tắt) — `arm_seam_smooth`
  legSmooth    số vòng mượt trọng số ở vùng trộn hai chân / thân — vạt áo phủ háng (mặc định 0) — `arm_seam_smooth` + LEG_CHAINS
  rigidHand    bàn tay một khối qua cổ tay (mặc định = noFingers) — `rigid_hand`
  armSpace     độ đẩy cánh tay ra xa thân trong clip (độ; mặc định 30; 0 = giữ clip gốc) — `arm_space`
  torsoClear   né thân: xoay cánh tay ra khi bàn tay lọt thân, từng khung (mặc định true) — `TorsoClearance`
  kneeRaise    nâng khớp gối dọc xương đùi, tính bằng phần của quãng hông → cổ chân (0,05 = 5%; mặc định 0) — `knee_raise`
  sleeveSkinFix tô lại màu da lọt lên mặt tay áo (true = ngưỡng 0,032·H, số = ngưỡng; mặc định tắt) — `sleeve_skin_fix`
  faceFromRef  chiếu mặt từ `mesh_views/front.png` (cạnh mesh vào) thẳng lên texture (mặc định tắt) — `face_from_ref`
  canonical    mesh vào đã đứng thẳng, Y lên, mặt hướng +Z — bỏ bước xoay về khung hông (mặc định true)
  modelsRoot   server bơm vào

Ra: rigged.glb (mọi clip), rigged.fbx, rest.glb (T-pose, không clip), joints.glb (que xương), bw.glb
(trọng số của LeftArm), info.json.
"""

from __future__ import annotations

import json
import math
import os
import shutil
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

# BPY PHẢI NẠP TRƯỚC MỌI THỨ. `trimesh` (bản [easy]) nạp trước thì `import bpy` chết với
# "DLL load failed … procedure could not be found" — hai bên kéo cùng một DLL khác bản, ai nạp
# trước thắng. Đo 2026-10-16: torch→bpy ổn, trimesh→bpy hỏng, bpy→trimesh ổn.
import bpy  # noqa: E402,F401

T0 = time.time()
HERE = Path(__file__).resolve().parent
# ai-studio: companion-web read these from its arm.json. Here the arm's server
# (src/arm_mia_st) sets them from its start parameters; the defaults are the
# arm's own vendor/ and second venv, as its README installs them.
MANIFEST = {
    "runtime": {"dirEnv": "MIA_DIR", "dir": str(HERE.parent / "vendor" / "make-it-animatable")},
    "skintokens": {
        "python": os.environ.get("SKINTOKENS_PYTHON")
        or str(HERE.parent / ".venv-skintokens" / "Scripts" / "python.exe"),
        "dir": os.environ.get("SKINTOKENS_DIR") or str(HERE.parent / "vendor" / "SkinTokens"),
    },
}


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[mia-rig {time.time() - T0:8.2f}] {msg}\n")
    sys.stderr.flush()


class Phase:
    """Bấm giờ từng giai đoạn — log tách giai đoạn, không chỉ tổng."""

    def __init__(self) -> None:
        self.ms: dict[str, int] = {}
        self.order: list[str] = []

    def __call__(self, name: str):
        ph = self

        class _C:
            def __enter__(self_):
                self_.t = time.time()
                emit("stage", stage=name)

            def __exit__(self_, *a):
                ph.ms[name] = int((time.time() - self_.t) * 1000)
                ph.order.append(name)
                log(f"{name}: {ph.ms[name]} ms")

        return _C()


def glb_normals(path: str):
    """Thuộc tính NORMAL của primitive đầu tiên trong một GLB (None nếu không có). trimesh BỎ QUA nó và tự
    tính lại từ mặt — đúng chỗ hỏng, xem `fix_winding`."""
    import json as _json
    import struct

    import numpy as np

    b = Path(path).read_bytes()
    if b[:4] != b"glTF":
        return None
    n = struct.unpack("<I", b[12:16])[0]
    g = _json.loads(b[20:20 + n])
    off = 20 + n
    blob = b[off + 8: off + 8 + struct.unpack("<I", b[off:off + 4])[0]]
    prims = [p for m in g.get("meshes", []) for p in m.get("primitives", [])]
    if len(prims) != 1 or "NORMAL" not in prims[0]["attributes"]:
        return None
    a = g["accessors"][prims[0]["attributes"]["NORMAL"]]
    bv = g["bufferViews"][a["bufferView"]]
    o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(blob, np.float32, a["count"] * 3, o).reshape(-1, 3)


def fix_winding(mesh, normals) -> int:
    """Lật mặt có pháp tuyến NGƯỢC pháp tuyến đỉnh Pixal3D đã lưu. Trả số mặt đã lật.

    Remesh UDF của Pixal3D để winding không nhất quán (0,6% mặt ở r06). File gốc có NORMAL đúng nên xem
    thì sạch; qua rig thì trimesh và Blender tính lại pháp tuyến TỪ MẶT → 2,3% đỉnh ngược → mảng đen trên
    áo trắng trong model-viewer (r22–r24).
    """
    import numpy as np

    if normals is None or len(normals) != len(mesh.vertices):
        return 0
    F = np.asarray(mesh.faces).copy()
    V = np.asarray(mesh.vertices)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    bad = (fn * normals[F].mean(1)).sum(1) < 0
    if bad.any():
        F[bad] = F[bad][:, ::-1]
        mesh.faces = F
    return int(bad.sum())


def strip_occlusion(path: Path) -> int:
    """Bỏ `occlusionTexture` khỏi mọi material của một GLB, viết đè. Trả số material đã sửa.

    AO Pixal3D bake cho tư thế TĨNH: lòng tay áo, nách ở A-pose bị che nên AO ≈ 0. Rig xong (T-pose, hay
    bất kỳ khung nào) các vùng đó lộ ra và viewer PBR nhân màu với AO → mảng đen (r22–r25). Workbench
    không dùng AO nên ảnh kiểm tra không thấy. Nhân vật chuyển động thì AO tĩnh vốn sai — bỏ là đúng.
    Ảnh AO vẫn nằm trong buffer (cùng ảnh ORM với roughness), chỉ không còn được tham chiếu làm AO.
    """
    import json as _json
    import struct

    b = path.read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    g = _json.loads(b[20:20 + n])
    k = 0
    for m in g.get("materials", []):
        if m.pop("occlusionTexture", None) is not None:
            k += 1
    if not k:
        return 0
    js = _json.dumps(g, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    rest = b[20 + n:]
    body = struct.pack("<I", len(js)) + b"JSON" + js + rest
    out = b[:8] + struct.pack("<I", 12 + len(body)) + body
    path.write_bytes(out)
    return k


class HeadShrink:
    """Thu nhỏ đầu chibi quanh điểm cổ trước khi đưa MIA dự đoán, rồi trả mọi thứ về chỗ cũ.

    VÌ SAO: MIA học trên nhân vật Mixamo tỉ lệ người. Chibi đầu ~43% chiều cao → nó đặt cổ và VAI vào
    TRONG cái đầu (r17: LeftArm y=0,569, Neck 0,596 trong khi vai thật ~0), xương tay không nằm trong tay,
    trọng số skin sai, và đưa A-pose về T-pose thì tay áo nằm lại còn bàn tay bay ra kéo theo dải mỏng.

    Biến dạng: co đều quanh `pivot` (tâm mặt cắt hẹp nhất = cổ) với hệ số r(d) giảm mượt từ 1 xuống `s`
    trong dải `band` phía TRÊN cổ (d = y − y_cổ). Dưới cổ không đổi — vai, tay, thân, chân y nguyên. Hệ số
    dọc trục được dựng từ độ dốc k(d) = 1 − (1−s)·d/band nên y' luôn tăng theo y: ngược được bằng công
    thức đóng (`undo`). Chỉ số đỉnh không đổi nên trọng số skin dự đoán trên mesh co dùng thẳng cho mesh gốc.
    """

    def __init__(self, V, target_ratio: float):
        import numpy as np

        y = V[:, 1]
        lo, hi = float(y.min()), float(y.max())
        H = hi - lo
        cx = float(np.median(V[:, 0]))
        best = None
        for k in range(int(0.5 * 80), int(0.8 * 80)):
            a = lo + H * k / 80
            sl = V[(y >= a) & (y < a + H / 80)]
            if len(sl) < 20:
                continue
            w = float(np.percentile(np.abs(sl[:, 0] - cx), 90))
            if best is None or w < best[0]:
                best = (w, a + H / 160, sl)
        _, ny, sl = best
        self.pivot = np.array([float(np.median(sl[:, 0])), ny, float(np.median(sl[:, 2]))], dtype=np.float64)
        self.H = H
        self.headRatio = (hi - ny) / H
        self.band = 0.06 * H
        # Đầu mới chiếm `target_ratio` chiều cao: head' = s·head (gần đúng, bỏ qua dải chuyển).
        self.s = min(1.0, target_ratio * (ny - lo) / ((1 - target_ratio) * (hi - ny)))
        self.active = self.s < 0.9

    def _h(self, d):
        import numpy as np

        b, s = self.band, self.s
        a = (1 - s) / (2 * b)
        return np.where(d <= 0, d, np.where(d < b, d - a * d * d, b * (1 + s) / 2 + s * (d - b)))

    def apply(self, P):
        import numpy as np

        P = np.asarray(P, dtype=np.float64)
        d = P[:, 1] - self.pivot[1]
        r = np.where(d > 1e-12, self._h(d) / np.maximum(d, 1e-12), 1.0)
        return self.pivot + (P - self.pivot) * r[:, None]

    def undo(self, Q):
        import numpy as np

        Q = np.asarray(Q, dtype=np.float64)
        dq = Q[:, 1] - self.pivot[1]
        b, s = self.band, self.s
        a = (1 - s) / (2 * b)
        hb = b * (1 + s) / 2
        d = np.where(dq <= 0, dq, np.where(dq >= hb, b + (dq - hb) / s,
                                           (1 - np.sqrt(np.maximum(1 - 4 * a * dq, 0))) / (2 * a)))
        r = np.where(dq > 1e-12, dq / np.maximum(d, 1e-12), 1.0)
        return self.pivot + (Q - self.pivot) / r[:, None]

    def info(self) -> dict:
        return {"neckY": round(float(self.pivot[1]), 4), "headRatio": round(self.headRatio, 3), "scale": round(self.s, 3),
                "band": round(self.band, 4), "applied": self.active}


def dist_weight_fix(bw, verts, joints, tails, parents, height: float, near: float = 0.04, far: float = 0.1):
    """Bỏ trọng số của xương nằm XA đỉnh. Hai luật, cả hai đều chỉ bác:

    1. Xương trội nằm xa đỉnh hơn `far`·cao trong khi có xương khác gần hơn hẳn → xương trội sai ngữ
       nghĩa (r19: hai dải đai buông ở hông bị MIA gán cho Head như tóc dài). Đỉnh chuyển sang xương
       GẦN NHẤT — đây là chỗ duy nhất có thêm, và nó là phép hình học, không phải đoán.
    2. Với các xương còn lại: giữ nếu là xương trội, cha/con trực tiếp của nó, hoặc nằm trong
       `near`·cao tính từ khoảng cách gần nhất. Còn lại bỏ, rồi chuẩn hoá.

    Khoảng cách là tới ĐOẠN xương (đầu → đuôi), trong hệ đã chuẩn hoá của MIA (cùng hệ với `verts`).
    """
    import numpy as np

    n_v, n_b = bw.shape
    A, B = joints[None], tails[None]
    out = np.empty_like(bw)
    adj = np.eye(n_b, dtype=bool)
    for c, p in enumerate(parents):
        if p is not None and p >= 0:
            adj[c, p] = adj[p, c] = True
    moved = 0
    removed = 0.0
    for s in range(0, n_v, 50000):
        P = verts[s:s + 50000, None, :]
        AB = B - A
        t = np.clip(((P - A) * AB).sum(-1) / np.maximum((AB * AB).sum(-1), 1e-12), 0, 1)
        D = np.linalg.norm(P - (A + t[..., None] * AB), axis=-1)  # (n, n_b)
        w = bw[s:s + 50000]
        dom = w.argmax(1)
        dmin = D.min(1)
        nearest = D.argmin(1)
        bad_dom = D[np.arange(len(dom)), dom] > dmin + far * height
        dom = np.where(bad_dom, nearest, dom)
        moved += int(bad_dom.sum())
        keep = adj[dom] | (D <= dmin[:, None] + near * height)
        keep[np.arange(len(dom)), dom] = True
        ww = w * keep
        removed += float((w * ~keep).sum())
        ssum = ww.sum(1, keepdims=True)
        ww = np.where(ssum > 1e-6, ww / np.maximum(ssum, 1e-6), np.eye(n_b)[dom])
        out[s:s + 50000] = ww
    return out.astype(bw.dtype), {"movedDominant": moved, "removedWeightShare": round(removed / max(float(bw.sum()), 1e-9), 4)}


def island_fix(bw, faces, iters: int = 8, frac: float = 0.6):
    """Lọc đa số trên đồ thị đỉnh: đỉnh có xương trội khác với ≥`frac` lân cận thì lấy trọng số TRUNG BÌNH
    của lân cận. Lặp `iters` vòng — ăn mòn dần các "đảo" gán sai từ mép vào.

    VÌ SAO: ở A-pose đầu ngón tay chạm ống quần → MIA gán vài cụm đỉnh ở ngón theo xương CHÂN (trội), nên
    luật theo xương trội không bắt được; tay nâng lên là các cụm đó ở lại, thành mũi nhọn (r23). Ranh giới
    thật giữa hai vùng lớn (cẳng tay|bàn tay) gần 50/50 lân cận nên không đạt `frac` — chỉ xê dịch rất ít.
    """
    import numpy as np
    import scipy.sparse as sp

    n, nb = bw.shape
    f = np.asarray(faces)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    A = sp.coo_matrix((np.ones(len(e) * 2, np.float32), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()
    w = bw.astype(np.float32).copy()
    changed = 0
    for _ in range(iters):
        lab = w.argmax(1)
        L = sp.csr_matrix((np.ones(n, np.float32), (np.arange(n), lab)), shape=(n, nb))
        cnt = (A @ L).toarray()
        maj = cnt.argmax(1)
        share = cnt[np.arange(n), maj] / np.maximum(deg, 1)
        m = (lab != maj) & (share >= frac) & (deg > 0)
        if not m.any():
            break
        avg = (A @ w) / np.maximum(deg, 1)[:, None]
        w[m] = avg[m]
        w[m] /= np.maximum(w[m].sum(1, keepdims=True), 1e-9)
        changed += int(m.sum())
    return w.astype(bw.dtype), {"relabelled": changed}


def _vertex_graph(faces, n: int):
    import numpy as np
    import scipy.sparse as sp

    f = np.asarray(faces, dtype=np.int64)
    e = np.unique(np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), 1), axis=0)
    A = sp.coo_matrix((np.ones(len(e) * 2, np.float32), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    return A, np.asarray(A.sum(1)).ravel()


ARM_CHAINS = tuple((s + "Shoulder", s + "Arm", s + "ForeArm", s + "Hand") for s in ("Left", "Right"))
# Vạt áo dài phủ qua háng: remesh hàn vạt trước/sau thành màng nối hai đùi; đùi tách ra là màng đó căng
# (r218 Run: 2302 cạnh > 3×, max 32,8, cặp xương LeftUpLeg/RightUpLeg 48/60).
LEG_CHAINS = tuple((s + "UpLeg", s + "Leg", s + "Foot", s + "ToeBase") for s in ("Left", "Right"))


def arm_seam_smooth(bw, faces, idx: dict[str, int], iters: int = 150, ring: int = 10, lo: float = 0.03,
                    chains: tuple = ARM_CHAINS):
    """Mượt Laplace trọng số trên đồ thị đỉnh, CHỈ ở vùng trộn giữa chuỗi tay một bên (vai → bàn tay) và
    phần còn lại, nới thêm `ring` vòng lân cận; ngoài vùng giữ nguyên làm biên.

    VÌ SAO: mesh A-pose, tay áo rộng — remesh UDF HÀN mặt trong tay áo vào sườn áo, mép dưới tay áo vào
    đai/hông. MIA dự đoán trọng số theo từng điểm, không biết nối, nên vùng hàn lổn nhổn tay/thân/chân
    (đỉnh cạnh nhau, đỉnh theo vai đỉnh theo Spine/UpLeg). Đưa tay lên T-pose hay giơ cao thì vùng đó xé
    thành sợi (r27: A→T cạnh giãn tối đa 63 lần, giơ thêm 70° tới 114 lần). Hàn là sự thật hình học,
    không cắt được — nhưng trọng số liền mạch thì độ giãn RẢI đều ra cả vùng như vải căng thay vì dồn
    vào một hàng cạnh. Đo trên r27 (numpy LBS): A→T max 63 → 3,1; giơ 70° max 114 → 4,6.
    """
    import numpy as np

    n, nb = bw.shape
    A, deg = _vertex_graph(faces, n)
    mix = np.zeros(n, bool)
    for prefixes in chains:
        ch = [i for k, i in idx.items() if k.split(":", 1)[-1].startswith(prefixes)]
        a = bw[:, ch].sum(1)
        mix |= (a > lo) & (a < 1 - lo)
    m = mix.copy()
    for _ in range(ring):
        m |= np.asarray(A @ m.astype(np.float32)).ravel() > 0
    w = bw.astype(np.float32).copy()
    inv = 1.0 / np.maximum(deg, 1)[:, None]
    for _ in range(iters):
        avg = (A @ w) * inv
        w[m] = 0.5 * w[m] + 0.5 * avg[m]
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    return w.astype(bw.dtype), {"verts": int(m.sum()), "seedVerts": int(mix.sum()), "iters": iters, "ring": ring}


def rigid_hand(bw, verts, joints, idx: dict[str, int], blend: float = 0.12):
    """Bàn tay một khối khi đã bỏ xương ngón: qua mặt phẳng cổ tay (khớp Hand, pháp tuyến theo cẳng tay)
    một đoạn `blend`·dài cẳng tay → 100% Hand; trước đó không còn Hand/ngón; ở giữa nội suy smoothstep.
    Chỉ áp cho đỉnh thuộc chuỗi tay bên đó (tổng trọng số chuỗi > 0,5).

    VÌ SAO: r27 tay TRÁI — MIA chuyển trọng số sang Hand ở GIỮA lòng bàn tay chứ không ở cổ tay (tại khớp
    Hand chỉ 13–20% Hand; tay phải 55–93%), và đầu ngón còn 16–23% ForeArm. Cổ tay gập là bàn tay gãy đôi,
    đầu ngón kéo thành sợi. Đo r27: gập cổ tay 60° thêm 314 cạnh giãn > 2 lần → còn 18.
    """
    import numpy as np

    out = bw.astype(np.float32).copy()
    names = {i: k.split(":", 1)[-1] for k, i in idx.items()}
    st = {}
    for side in ("Left", "Right"):
        hand, fa = idx.get(f"mixamorig:{side}Hand"), idx.get(f"mixamorig:{side}ForeArm")
        if hand is None or fa is None:
            continue
        chain = [i for i, nm in names.items() if nm.startswith((side + "Hand", side + "ForeArm", side + "Arm"))]
        fing = [i for i, nm in names.items() if nm.startswith(side + "Hand")]
        hj, fj = np.asarray(joints[hand], np.float64), np.asarray(joints[fa], np.float64)
        Lf = float(np.linalg.norm(hj - fj))
        t = (np.asarray(verts) - hj) @ ((hj - fj) / Lf) / Lf
        on = out[:, chain].sum(1) > 0.5
        a = np.clip((t + blend) / (2 * blend), 0, 1)
        a = a * a * (3 - 2 * a)
        m = on & (t > -blend)
        rest = out[m].copy()
        rest[:, fing] = 0
        rs = rest.sum(1, keepdims=True)
        rest = np.where(rs > 1e-6, rest / np.maximum(rs, 1e-6), np.eye(out.shape[1], dtype=np.float32)[fa])
        new = rest * (1 - a[m, None])
        new[:, hand] += a[m]
        out[m] = new
        before = out[on & (t <= -blend)]
        before[:, fing] = 0
        out[on & (t <= -blend)] = before
        st[side] = {"handVerts": int((m & (a > 0.999)).sum()), "blendVerts": int((m & (a <= 0.999)).sum())}
    out /= np.maximum(out.sum(1, keepdims=True), 1e-9)
    return out.astype(bw.dtype), st


def heat_weights(verts, faces, joints, tails, bone_names: list[str], parents: list[int], keep: list[int],
                 voxel_frac: float = 0.006, scale: float = 100.0):
    """Trọng số bằng BONE HEAT của Blender (ARMATURE_AUTO) — khớp vẫn của MIA, chỉ thay trọng số.

    VÌ SAO: MIA đoán trọng số theo từng ĐIỂM, không biết mặt nào nối với mặt nào; quần áo rộng (tay áo
    buông, vạt, đai) ra lổn nhổn → tay giơ lên là xé thành màng/sợi (r27–r40). Bone heat khuếch tán nhiệt
    TRÊN BỀ MẶT từ các xương nhìn thấy được → trọng số liền mạch theo hình học. Đo r40 (cùng khớp): A→T
    max 90 → 3,5; giơ tay 70° max 121 → 7,8; hạ tay sát người max 47 → 5,7.

    Bone heat hỏng ("failed to find solution") trên mesh Pixal3D thô: nhiều lớp, nhiều mảnh rời, và mô hình
    quá NHỎ so với epsilon cố định của nó. Nên tính trên PROXY: voxel remesh (một vỏ kín), giữ mảnh liền
    lớn nhất, phóng to `scale` lần; rồi chuyển về mesh gốc bằng 4 đỉnh proxy gần nhất (nghịch khoảng cách).
    """
    import bmesh
    import bpy
    import numpy as np
    from scipy.spatial import cKDTree

    V = np.asarray(verts, np.float64)
    H = float(V[:, 1].max() - V[:, 1].min())
    made = []
    me = bpy.data.meshes.new("heat_proxy")
    me.from_pydata((V * scale).tolist(), [], np.asarray(faces, np.int64).tolist())
    proxy = bpy.data.objects.new("heat_proxy", me)
    bpy.context.scene.collection.objects.link(proxy)
    made.append(proxy)
    bpy.context.view_layer.objects.active = proxy
    if voxel_frac:
        # voxel_frac=0: mesh vào ĐÃ là một vỏ kín (prep.py) — voxel lần nữa trên bản đã decimate làm vỡ chỗ mỏng
        # thành hàng trăm mảnh (r53: 569 mảnh, phần rời nhận trọng số của chỗ gần nhất → gán sai xương).
        mod = proxy.modifiers.new("vox", "REMESH")
        mod.mode = "VOXEL"
        mod.voxel_size = H * voxel_frac * scale
        bpy.ops.object.modifier_apply(modifier="vox")
    bm = bmesh.new()
    bm.from_mesh(proxy.data)
    seen: set = set()
    comps = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        seen.add(v.index)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    bmesh.ops.delete(bm, geom=[v for c in comps[1:] for v in c], context="VERTS")
    bm.to_mesh(proxy.data)
    bm.free()

    ad = bpy.data.armatures.new("heat_arm")
    ao = bpy.data.objects.new("heat_arm", ad)
    bpy.context.scene.collection.objects.link(ao)
    made.append(ao)
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for i in keep:
        b = ad.edit_bones.new(bone_names[i])
        tail = tails[i] if np.linalg.norm(tails[i] - joints[i]) > 1e-4 else joints[i] + np.array([0, H * 0.03, 0])
        b.head, b.tail = (np.asarray(joints[i]) * scale).tolist(), (np.asarray(tail) * scale).tolist()
        eb[i] = b
    for i in keep:
        p = parents[i]
        while p is not None and p >= 0 and p not in eb:
            p = parents[p]
        if p is not None and p >= 0:
            eb[i].parent = eb[p]
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    proxy.select_set(True)
    ao.select_set(True)
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    pv = np.array([v.co[:] for v in proxy.data.vertices]) / scale
    PW = np.zeros((len(pv), len(bone_names)), np.float32)
    col = {g.index: bone_names.index(g.name) for g in proxy.vertex_groups}
    for v in proxy.data.vertices:
        for g in v.groups:
            PW[v.index, col[g.group]] = g.weight
    ok = PW.sum(1) > 1e-6
    stats = {"proxyVerts": int(len(pv)), "proxyComponents": len(comps), "proxyUnweighted": int((~ok).sum())}
    for o in made:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)
        elif isinstance(data, bpy.types.Armature):
            bpy.data.armatures.remove(data)
    if ok.sum() < 0.5 * len(pv):
        raise RuntimeError(f"bone heat failed on the proxy: {stats}")
    dd, ii = cKDTree(pv[ok]).query(V, k=4)
    w = 1 / np.maximum(dd, 1e-9)
    W = (PW[ok][ii] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    stats["transferDistP99OverH"] = round(float(np.percentile(dd[:, 0], 99) / H), 4)
    return W.astype(np.float32), stats


def arm_space(arm_obj, act, deg: float) -> dict:
    """Như thanh "Character Arm-Space" của Mixamo: đẩy cánh tay (LeftArm/RightArm) ra XA THÂN trong clip.

    Clip Mixamo làm cho tỉ lệ người: tay buông sát sườn. Chibi thân to, tay áo rộng, đầu to → tay xuyên thân
    lúc buông, xuyên mặt lúc giơ. Mỗi khung: hướng cánh tay d (không gian armature) được xoay về phía NGANG
    (hướng tay ở tư thế nghỉ T-pose) một góc `deg`·|d·lên| — tay buông/giơ thẳng thì đẩy đủ, tay đã ngang thì
    không đụng. Tay buông bị đẩy ra ngoài và lên; tay giơ bị đẩy ra ngoài và xuống — cả hai đều xa thân/đầu.
    Chỉ ghi lại khoá xoay của cánh tay; cẳng tay, bàn tay giữ khoá cũ nên đi theo.
    """
    import math

    import bpy
    from mathutils import Matrix, Vector

    sc = bpy.context.scene
    arm_obj.animation_data.action = act
    up = (arm_obj.matrix_world.to_3x3().inverted() @ Vector((0, 0, 1))).normalized()
    sides = []
    for nm in ("mixamorig:LeftArm", "mixamorig:RightArm"):
        pb = arm_obj.pose.bones.get(nm)
        if pb is None:
            continue
        ch = arm_obj.pose.bones.get(nm.replace("Arm", "ForeArm"))
        if ch is None:
            continue
        # Hướng theo đầu cẳng tay, không theo trục Y của bone — bone nhập từ glTF có thể xoay trục.
        lat = ch.bone.head_local - pb.bone.head_local
        lat = (lat - up * lat.dot(up)).normalized()
        path = "rotation_quaternion" if pb.rotation_mode == "QUATERNION" else (
            "rotation_axis_angle" if pb.rotation_mode == "AXIS_ANGLE" else "rotation_euler")
        sides.append((pb, ch, lat, path))
    f0, f1 = (int(round(v)) for v in act.frame_range)
    rad = math.radians(deg)
    mx = 0.0
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        new = []
        for pb, ch, lat, path in sides:
            M = pb.matrix.copy()
            d = (ch.head - pb.head).normalized()
            axis = d.cross(lat)
            a = rad * abs(d.dot(up))
            if axis.length < 1e-4 or a < 1e-5:
                continue
            R = Matrix.Rotation(a, 4, axis.normalized())
            M2 = R @ M.to_3x3().to_4x4()
            M2.translation = M.translation
            new.append((pb, M2, path))
            mx = max(mx, a)
        for pb, M2, path in new:
            pb.matrix = M2
            pb.keyframe_insert(path, frame=f)
    arm_obj.animation_data.action = None
    return {"deg": deg, "frames": f1 - f0 + 1, "maxDeg": round(math.degrees(mx), 1)}


# Né thân: ngưỡng, lưới hồ sơ và bước tìm góc — Char3dAnimViewer.vue dùng cùng các số này.
TORSO_BONES = ("mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2")
TORSO_CLEAR = 0.006  # bàn tay phải ở ngoài mặt thân ít nhất ngần này (× chiều cao)
TORSO_U_BINS = 6  # số lát mỗi đoạn trục sống
TORSO_A_BINS = 24  # số múi góc quanh trục
TORSO_EXT = 0.2  # đoạn trục kéo dài xuống dưới đầu xương Hips (× chiều cao) — vạt áo, mông
TORSO_MAX_DEG = 70


class TorsoProfile:
    """Thân = hồ sơ BÁN KÍNH quanh trục sống: chuỗi Hips → Spine → Spine1 → Spine2 → Neck (thêm một đoạn kéo xuống
    dưới Hips). Mỗi điểm quy về (u = đoạn + vị trí trên đoạn, θ = góc trong khung xương của đoạn, r = cách trục).
    R[u][θ] = r lớn nhất của các đỉnh thân (xương trội thuộc TORSO_BONES) lúc nghỉ. Điểm lọt thân khi r < R + biên.

    VÌ SAO KHÔNG THEO PHÁP TUYẾN: mesh Pixal3D là vỏ hai lớp, pháp tuyến lẫn trong/ngoài. Hồ sơ đi theo xương nên
    xoay người, cúi người vẫn đúng; vạt áo loe ra ngoài tay cũng tính là thân (tay lọt dưới vạt là lẹm thật)."""

    def __init__(self, chain_rest, frames_rest, verts, height: float):
        import numpy as np

        self.H = height
        self.R = np.zeros(((len(chain_rest) - 1 + 1) * TORSO_U_BINS, TORSO_A_BINS), dtype=np.float32)
        for p in verts:
            u, a, r = self._coords(p, chain_rest, frames_rest)
            if u is None:
                continue
            ui = min(int(u * TORSO_U_BINS), self.R.shape[0] - 1)
            ai = int(a / (2 * math.pi) * TORSO_A_BINS) % TORSO_A_BINS
            self.R[ui, ai] = max(self.R[ui, ai], r)

    def _coords(self, p, chain, frames):
        """(u, θ, r) của điểm p với chuỗi trục `chain` (Vector, n+1 điểm) và khung xương `frames` (Matrix 3×3, n)."""
        import numpy as np

        d0 = (chain[1] - chain[0]).normalized()
        pts = [chain[0] - d0 * (TORSO_EXT * self.H)] + list(chain)
        fr = [frames[0]] + list(frames)
        best = None
        for k in range(len(pts) - 1):
            a, b = pts[k], pts[k + 1]
            ab = b - a
            L2 = ab.length_squared
            if L2 < 1e-12:
                continue
            t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
            q = a + ab * t
            dist = (p - q).length
            if best is None or dist < best[0]:
                best = (dist, k, t, q, ab.normalized())
        if best is None:
            return None, 0.0, 0.0
        dist, k, t, q, d = best
        X = fr[k].col[0]
        e1 = X - d * X.dot(d)
        if e1.length < 1e-6:
            e1 = fr[k].col[2] - d * fr[k].col[2].dot(d)
        e1 = e1.normalized()
        e2 = d.cross(e1)
        w = p - q
        ang = math.atan2(w.dot(e2), w.dot(e1)) % (2 * math.pi)
        return k + t, ang, float(np.float32(dist))

    def inside(self, p, chain, frames) -> bool:
        u, a, r = self._coords(p, chain, frames)
        if u is None:
            return False
        ui = min(int(u * TORSO_U_BINS), self.R.shape[0] - 1)
        ai = int(a / (2 * math.pi) * TORSO_A_BINS) % TORSO_A_BINS
        R = float(self.R[ui, ai])
        return R > 0 and r < R + TORSO_CLEAR * self.H

    def axis_point(self, p, chain):
        """Điểm gần nhất trên trục sống — tâm để xoay tay ra xa."""
        best, out = None, chain[0]
        for a, b in zip(chain[:-1], chain[1:]):
            ab = b - a
            t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
            q = a + ab * t
            if best is None or (p - q).length < best:
                best, out = (p - q).length, q
        return out


def smooth_need(need):
    """Làm mượt góc cần xoay theo thời gian: max ±3 khung rồi Gauss σ 2 khung (như né đầu ở trang review)."""
    import numpy as np

    N = len(need)
    mx = np.array([need[max(0, i - 3):i + 4].max() for i in range(N)])
    sm = np.zeros(N)
    for i in range(N):
        ks = np.arange(max(0, i - 6), min(N, i + 7))
        g = np.exp(-((ks - i) ** 2) / 8)
        sm[i] = (g * mx[ks]).sum() / g.sum()
    return sm


def smooth_axes(axes: list, need):
    """Làm mượt trục xoay theo thời gian (Gauss σ 2 khung, trọng số = góc cần xoay) — trục không được nhảy giữa hai khung."""
    import numpy as np
    from mathutils import Vector

    N = len(axes)
    w = np.array([max(float(x), 1.0) for x in need])
    out: list = [None] * N
    for i in range(N):
        acc = Vector((0.0, 0.0, 0.0))
        for k in range(max(0, i - 6), min(N, i + 7)):
            if axes[k] is not None:
                acc += axes[k] * (math.exp(-((k - i) ** 2) / 8) * w[k])
        if acc.length > 1e-9:
            out[i] = acc.normalized()
    return out


class TorsoClearance:
    """Né thân: mỗi khung, điểm bàn tay (24 đỉnh trội Hand lấy mẫu, khớp Hand, giữa cẳng tay) lọt hồ sơ thân → xoay
    cánh tay quanh vai, RA XA trục sống, góc nhỏ nhất (bước 2°, tối đa 70°) đủ ra ngoài; góc làm mượt theo thời gian.
    Như né đầu của trang review — `armSpace` góc cố định không gỡ được tay chống hông / vòng ra sau lưng / xoay người
    trên thân chibi to (r44 → r45: 74 → 58/240 khung, log char3d). Dựng MỘT lần ở tư thế nghỉ, `apply` từng clip
    SAU arm_space; chỉ ghi lại khoá xoay của LeftArm/RightArm."""

    CHAIN = list(TORSO_BONES) + ["mixamorig:Neck"]

    def __init__(self, arm_obj, mesh_obj):
        import numpy as np

        self.ok = all(n in arm_obj.data.bones for n in self.CHAIN)
        self.arm = arm_obj
        if not self.ok:
            return
        W = arm_obj.matrix_world
        names = {g.index: g.name for g in mesh_obj.vertex_groups}
        Mw = mesh_obj.matrix_world
        torso, hands, zs = [], {"Left": [], "Right": []}, []
        for v in mesh_obj.data.vertices:
            co = Mw @ v.co
            zs.append(co.z)
            if not v.groups:
                continue
            nm = names.get(max(v.groups, key=lambda g: g.weight).group, "")
            if nm in TORSO_BONES:
                torso.append(co)
            elif nm in ("mixamorig:LeftHand", "mixamorig:RightHand"):
                hands["Left" if "Left" in nm else "Right"].append(co)
        bones = arm_obj.data.bones
        chain = [W @ bones[n].head_local for n in self.CHAIN]
        frames = [W.to_3x3() @ bones[n].matrix_local.to_3x3() for n in TORSO_BONES]
        self.prof = TorsoProfile(chain, frames, torso, max(zs) - min(zs))
        rng = np.random.default_rng(0)
        self.sides = []
        for side in ("Left", "Right"):
            pb = arm_obj.pose.bones.get(f"mixamorig:{side}Arm")
            fore = arm_obj.pose.bones.get(f"mixamorig:{side}ForeArm")
            hand = arm_obj.pose.bones.get(f"mixamorig:{side}Hand")
            if pb is None or fore is None or hand is None:
                continue
            hp = hands[side]
            pick = rng.choice(len(hp), min(24, len(hp)), replace=False) if hp else []
            inv = (W @ hand.bone.matrix_local).inverted()
            path = "rotation_quaternion" if pb.rotation_mode == "QUATERNION" else (
                "rotation_axis_angle" if pb.rotation_mode == "AXIS_ANGLE" else "rotation_euler")
            self.sides.append((side, pb, fore, hand, [inv @ hp[i] for i in pick], path))

    def apply(self, act) -> dict:
        import numpy as np

        import bpy
        from mathutils import Matrix

        info = {"clip": act.name}
        if not self.ok:
            info["skipped"] = "missing spine bones"
            return info
        sc = bpy.context.scene
        arm, W = self.arm, self.arm.matrix_world
        W3 = W.to_3x3()
        arm.animation_data.action = act
        f0, f1 = (int(round(v)) for v in act.frame_range)
        N = f1 - f0 + 1
        need = {s[0]: np.zeros(N) for s in self.sides}
        axes = {s[0]: [None] * N for s in self.sides}
        # Giá trị xoay cánh tay ở từng khung NGUYÊN — để ghi lại khoá theo khung nguyên (clip nạp từ glTF có khoá ở
        # khung lẻ 0,4/0,8…; ghi đè khung nguyên mà để khoá lẻ lại thì giữa hai khung vẫn là tay cũ).
        base = {s[0]: [] for s in self.sides}
        for i in range(N):
            sc.frame_set(f0 + i)
            for side, pb, *_r, path in self.sides:
                base[side].append(tuple(getattr(pb, path)))
            chain = [W @ arm.pose.bones[n].head for n in self.CHAIN]
            frames = [W3 @ arm.pose.bones[n].matrix.to_3x3() for n in TORSO_BONES]
            for side, pb, fore, hand, local, _ in self.sides:
                sh = W @ pb.head
                hpos = W @ hand.head
                Mh = W @ hand.matrix
                pts = [hpos, (W @ fore.head + hpos) * 0.5] + [Mh @ l for l in local]
                # Hướng đẩy = NGANG của thân phía vai này (trục sống → vai, bỏ thành phần dọc sống) — DANG tay sang
                # ngang như armSpace, góc theo từng khung. Không theo bàn tay: hai bản trước (vai→tay × vai→trục sống;
                # vai→tay × trục sống→tay) đổi hướng đẩy khi tay vòng từ hông ra sau lưng → tay quét vòng cung, nhìn
                # như xoắn một vòng (Walk r46, người dùng bắt).
                spine = chain[3] - chain[2]
                lat = sh - self.prof.axis_point(sh, chain)
                lat = lat - spine * (lat.dot(spine) / max(spine.length_squared, 1e-12))
                ax = (hpos - sh).cross(lat)
                if ax.length < 1e-9:
                    continue
                axes[side][i] = ax.normalized()
                if not any(self.prof.inside(p, chain, frames) for p in pts):
                    continue
                need[side][i] = TORSO_MAX_DEG
                for d in range(2, TORSO_MAX_DEG + 1, 2):
                    R = Matrix.Rotation(math.radians(d), 3, axes[side][i])
                    if not any(self.prof.inside(sh + R @ (p - sh), chain, frames) for p in pts):
                        need[side][i] = d
                        break
        sm = {side: smooth_need(need[side]) for side in need}
        sax = {side: smooth_axes(axes[side], need[side]) for side in need}
        for side, *_ in self.sides:
            moved = sm[side] >= 0.5
            # Bước nhảy lớn nhất giữa hai khung của phép xoay đã thêm — xoắn tay hiện ra ở đây (r46 bản đầu: ~60°/khung).
            step = 0.0
            for i in range(1, N):
                if sax[side][i] is None or sax[side][i - 1] is None:
                    continue
                q0 = Matrix.Rotation(math.radians(sm[side][i - 1]), 3, sax[side][i - 1]).to_quaternion()
                q1 = Matrix.Rotation(math.radians(sm[side][i]), 3, sax[side][i]).to_quaternion()
                a = math.degrees(q0.rotation_difference(q1).angle)
                step = max(step, min(a, 360 - a))
            info[side] = {"maxDeg": round(float(sm[side].max()), 1) if N else 0.0, "frames": int(moved.sum()), "of": N,
                          "maxStepDeg": round(step, 1)}
        for side, pb, *_r, path in self.sides:
            if not (sm[side] >= 0.5).any():
                continue
            dp = pb.path_from_id(path)
            for fc in [c for c in act.fcurves if c.data_path == dp]:
                fc.keyframe_points.clear()
                fc.keyframe_points.add(N)
                for i in range(N):
                    fc.keyframe_points[i].co = (f0 + i, base[side][i][fc.array_index])
                    fc.keyframe_points[i].interpolation = "LINEAR"
                fc.update()
        prev_q: dict = {}
        for i in range(N):
            todo = [s for s in self.sides if sm[s[0]][i] >= 0.5]
            if not todo:
                prev_q.clear()
                continue
            sc.frame_set(f0 + i)
            new = []
            for side, pb, fore, hand, local, path in todo:
                ax = sax[side][i]
                if ax is None:
                    continue
                Ra = (W3.inverted() @ Matrix.Rotation(math.radians(sm[side][i]), 3, ax) @ W3).to_4x4()
                M = pb.matrix.copy()
                M2 = Ra @ M.to_3x3().to_4x4()
                M2.translation = M.translation
                new.append((side, pb, M2, path))
            # Hai tay độc lập: tính xong cả hai rồi mới ghi, như arm_space.
            for side, pb, M2, path in new:
                pb.matrix = M2
                # Giữ dấu quaternion liền mạch với khoá trước: fcurve nội suy từng thành phần, q và −q liền nhau là
                # tay quay một vòng giữa hai khung.
                if path == "rotation_quaternion":
                    q = pb.rotation_quaternion
                    ref = prev_q.get(side) or base[side][i]
                    if sum(a * b for a, b in zip(q, ref)) < 0:
                        pb.rotation_quaternion = -q
                    prev_q[side] = tuple(pb.rotation_quaternion)
                pb.keyframe_insert(path, frame=f0 + i)
        arm.animation_data.action = None
        return info


def knee_raise(db, idx: dict[str, int], frac: float) -> dict:
    """Dời khớp gối (LeftLeg/RightLeg) LÊN dọc xương đùi một đoạn = `frac` × quãng hông → cổ chân. Đuôi xương đùi
    đi theo cùng đoạn. Chạy TRƯỚC khi tính trọng số — trọng số phải theo khớp mới.

    VÌ SAO: trên chibi quần thụng, MIA đặt gối ở ~58% quãng hông → cổ chân (r105/r108; người ~50%) — người dùng
    thấy gối thấp: chân gập ở chỗ ống quần chứ không ở giữa chân.
    """
    import numpy as np

    J = np.asarray(db.joints, dtype=np.float32).copy()
    T = np.asarray(db.joints_tail, dtype=np.float32).copy()
    out = {"frac": frac}
    for side in ("Left", "Right"):
        k = {n: idx.get(f"mixamorig:{side}{n}") for n in ("UpLeg", "Leg", "Foot")}
        if any(v is None for v in k.values()):
            continue
        hip, knee, ankle = J[k["UpLeg"]], J[k["Leg"]], J[k["Foot"]]
        leg = float(np.linalg.norm(ankle - hip))
        thigh = hip - knee
        new = knee + thigh / max(float(np.linalg.norm(thigh)), 1e-9) * frac * leg
        before = float(np.linalg.norm(knee - hip)) / leg
        # Đuôi xương đùi của MIA nằm SÁT gối chứ không trùng (lệch ~0,004) — dời cùng một đoạn.
        T[k["UpLeg"]] += new - knee
        J[k["Leg"]] = new
        out[side] = {"before": round(before, 3), "after": round(float(np.linalg.norm(new - hip)) / leg, 3)}
    db.joints, db.joints_tail = J, T
    return out


def sleeve_skin_fix(arm_obj, mesh_obj, dmin: float = 0.032) -> dict:
    """Tô lại texel MÀU DA nằm trên MẶT TAY ÁO bằng màu vải quanh đó. Sửa ảnh base color tại chỗ (đã pack).

    VÌ SAO: ảnh ref vẽ tay áo rộng, HỞ — nhìn qua miệng tay áo thấy da cánh tay bên trong. Pixal3D dựng tay
    áo một vỏ, không có lòng trong, nên da đó bị chiếu lên mặt vải ngay trong viền (r95: dải da cả hai tay,
    trước lẫn sau). Ref sinh lại thì mesh cũng đổi — sửa ở texture giữ được mesh đã chọn.

    Mặt tay áo = đỉnh xa trục cánh tay (khớp vai → khuỷu → cổ tay của chính lượt rig) hơn `dmin`·H, trong đoạn
    giữa bắp tay → giữa cẳng tay. Đo r95: da cẳng tay p90 0,022·H, vải tay áo 0,03–0,056·H; 0,026 thì lẹm một
    mảng da cẳng tay phải sát viền → 0,032. Màu da = R > B + 18 (vải trắng ngả tím có B ≥ R). Giữ một phần
    độ sáng tối gốc (0,93–1,03) cho nếp vải.
    """
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw

    img = None
    for m in mesh_obj.data.materials:
        for nd in (m.node_tree.nodes if m and m.use_nodes else []):
            if nd.type == "TEX_IMAGE" and nd.image and any(l.to_socket.name == "Base Color" for l in nd.outputs[0].links):
                img = nd.image
    if img is None:
        return {"skipped": "no base color image"}
    me = mesh_obj.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    Mw = np.array(mesh_obj.matrix_world)
    co = co.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]
    H = float(np.ptp(co[:, 2]))
    A = arm_obj.matrix_world
    B = {b.name.split(":")[-1]: b for b in arm_obj.data.bones}
    sleeve = np.zeros(n, bool)
    for side in ("Left", "Right"):
        if not all(side + k in B for k in ("Arm", "ForeArm", "Hand")):
            continue
        s, e, h = (np.array(A @ B[side + k].head_local) for k in ("Arm", "ForeArm", "Hand"))

        def seg(a, b):
            d = b - a
            t = ((co - a) @ d) / (d @ d)
            return np.linalg.norm(co - (a + np.clip(t, 0, 1)[:, None] * d), axis=1), t

        du, tu = seg(s, e)
        df, tf = seg(e, h)
        d = np.minimum(du, df)
        sleeve |= (tu > 0.3) & (tf < 0.6) & (d > dmin * H) & (d < 0.09 * H)
    W, Hh = img.size
    nl = len(me.loops)
    uv = np.empty(nl * 2)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    lv = np.empty(nl, int)
    me.loops.foreach_get("vertex_index", lv)
    ls = np.empty(len(me.polygons), int)
    lt = np.empty(len(me.polygons), int)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    # Mảng pixel của Blender đi từ hàng DƯỚI lên: hàng = v·H, vẽ thẳng không lật.
    mask = Image.new("L", (W, Hh), 0)
    other = Image.new("L", (W, Hh), 0)
    dr, do = ImageDraw.Draw(mask), ImageDraw.Draw(other)
    nf = 0
    for a0, k in zip(ls, lt):
        idx = range(a0, a0 + k)
        poly = [(uv[i, 0] * W, uv[i, 1] * Hh) for i in idx]
        if all(sleeve[lv[i]] for i in idx):
            dr.polygon(poly, fill=255)
            nf += 1
        else:
            do.polygon(poly, fill=255)
    core = np.asarray(mask) > 0
    # Nới 2 px cho viền đệm UV — chỉ vào texel TRỐNG: atlas phân mảnh, mảnh bàn tay có thể nằm sát mảnh tay áo
    # (r114: nới không chặn thì tô lốm đốm lên ngón tay, cẳng tay).
    sl = (cv2.dilate(core.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & (core | ~(np.asarray(other) > 0))
    px = np.empty(W * Hh * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(Hh, W, 4)
    a = px[..., :3] * 255
    R, G, Bc = a[..., 0], a[..., 1], a[..., 2]
    lum = a.mean(axis=2)
    fix = sl & (R > Bc + 18) & (R >= G - 4) & (R > 110)
    # Viền tối của dải da (bóng nâu xám sát viền tay áo): nới 4 px, trừ vải xanh đậm của viền.
    navy = (Bc > R + 8) & (lum < 150)
    grow = cv2.dilate(fix.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    fix |= grow & sl & ~navy & (lum > 90) & (a.min(axis=2) < 225)
    cloth = sl & ~fix & (a.min(axis=2) > 170)
    if not fix.any() or cloth.sum() < 100:
        return {"faces": nf, "fixedPx": 0}
    white = np.median(a[cloth], axis=0)
    k = np.clip(lum / np.median(lum[fix]), 0.93, 1.03)[..., None]
    # Viền mềm cũng không được tràn khỏi vùng tay áo.
    soft = (np.maximum(cv2.GaussianBlur(fix.astype(np.float32), (5, 5), 0), fix.astype(np.float32)) * sl)[..., None]
    a = a * (1 - soft) + np.clip(white * k, 0, 255) * soft
    px[..., :3] = a / 255
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()  # bộ xuất glTF/FBX lấy ảnh đã pack — không pack thì ghi lại bytes gốc
    return {"faces": nf, "fixedPx": int(fix.sum()), "cloth": [round(float(x)) for x in white], "dmin": dmin}


FACE_FACING = (0.05, 0.3)
FACE_TOP = (0.2, 0.32)


def face_from_ref(mesh_obj, view_path: Path, feather: float = 6.0) -> dict:
    """Chiếu MẶT từ ảnh front (đúng ảnh Pixal3D nhận, `mesh_views/front.png`) thẳng lên base color.

    VÌ SAO: Pixal3D không chép mặt từ ref mà tô lại theo seed — cùng một ảnh vào (r121, mắt tròn có đốm
    sáng) ra mắt đồng tử dọc như mắt mèo, chấm lấm tấm dưới mắt, má hồng thành mảng (r123–r125); 40 lượt
    mesh của project chỉ vài lượt mặt sạch (r95 là may). Ảnh front nằm sẵn đó, mặt lại gần như phẳng hướng
    ra trước nên chiếu thẳng là đủ.

    Căn: bóng mesh chiếu trực giao lên mặt phẳng ảnh, khớp hộp bao rồi dò tỉ lệ ±8% + dịch ±24 px theo IoU
    với bóng ảnh (nền đen) ở dải đầu. Thử cả hai chiều trước/sau vì cảnh rig có thể đã xoay mesh. Vùng mặt = mảng màu
    da lớn nhất ở nửa trên ảnh, lấp lỗ (mắt, miệng) bằng bao lồi, viền mềm `feather` px. Texel chỉ nhận màu
    khi tam giác của nó quay ra trước (mờ dần từ 0,3 → 0,65) và không bị che (z-buffer kiểu painter). Sau
    đó loang phần chênh màu ra khe UV ngoài đảo — không loang thì viền đảo giữ màu cũ, lấy mẫu song tuyến
    kéo nó vào thành vệt nứt mảnh khắp mặt (thử đầu trên r125).
    """
    import cv2
    import numpy as np
    from PIL import Image

    img = None
    for m in mesh_obj.data.materials:
        for nd in (m.node_tree.nodes if m and m.use_nodes else []):
            if nd.type == "TEX_IMAGE" and nd.image and any(l.to_socket.name == "Base Color" for l in nd.outputs[0].links):
                img = nd.image
    if img is None:
        return {"skipped": "no base color image"}
    if not view_path.is_file():
        return {"skipped": f"no front view: {view_path}"}
    view = np.asarray(Image.open(view_path).convert("RGB"), np.float32)
    S = view.shape[0]
    sil_img = (view.sum(2) > 12).astype(np.uint8)
    ys, xs = np.nonzero(sil_img)
    ib = np.array([xs.min(), ys.min(), xs.max(), ys.max()], float)

    me = mesh_obj.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    Mw = np.array(mesh_obj.matrix_world)
    co = co.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tv = np.empty(nt * 3, int)
    me.loop_triangles.foreach_get("vertices", tv)
    tv = tv.reshape(-1, 3)
    tl = np.empty(nt * 3, int)
    me.loop_triangles.foreach_get("loops", tl)
    tl = tl.reshape(-1, 3)
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    P = co[tv]
    fn = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    lo, hi = co.min(0), co.max(0)
    Hm = float(hi[2] - lo[2])

    # --- vùng mặt trong ảnh ---
    r, g, b = view[..., 0], view[..., 1], view[..., 2]
    skin = (r > 200) & (r > b + 12) & (g > 170) & (r - g < 60)
    skin[int(S * 0.55):] = False
    nlab, lab, cst, _ = cv2.connectedComponentsWithStats(skin.astype(np.uint8))
    if nlab < 2:
        return {"skipped": "no skin region in front view"}
    face = (lab == 1 + int(np.argmax(cst[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    # Bao lồi, không lấp lỗ: mắt chạm tóc ở đuôi nên không thành lỗ kín — lấp lỗ bỏ sót mắt (thử r125).
    cnt, _ = cv2.findContours(face, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = np.zeros_like(face)
    cv2.fillPoly(hull, [cv2.convexHull(np.vstack(cnt))], 1)
    x0, y0, w0, h0 = cv2.boundingRect(hull)
    fm = cv2.GaussianBlur(cv2.erode(hull, np.ones((5, 5), np.uint8)).astype(np.float32), (0, 0), feather)
    # Bỏ trán trở lên (mờ dần quanh ngang lông mày): bao lồi nuốt cả tóc mái phủ trán trong ảnh, chiếu lên
    # trán mesh — chỗ mesh không có mái — thành sợi tóc ma, nhìn 3/4 rất rõ (thử r124, r95). Tính theo BỀ NGANG
    # mặt vì chiều cao lẫn cả cổ (r38: 210 px so với 166). Đo ảnh front 1024: lông mày ~0,32·w, mép trên mắt ~0,48·w.
    ramp = np.clip((np.arange(S, dtype=np.float32) - (y0 + FACE_TOP[0] * w0)) / ((FACE_TOP[1] - FACE_TOP[0]) * w0), 0, 1)
    fm *= ramp[:, None]

    # --- căn bóng: vẽ bóng một lần ở phép chiếu gốc, dò tỉ lệ/dịch bằng warp mặt nạ. IoU chỉ tính ở DẢI ĐẦU
    # (tới dưới cằm): trong cảnh rig mesh đã về tư thế nghỉ của khung Mixamo, tay lệch ảnh front — IoU cả
    # người r125 tụt 0,92 → 0,79 (r127), trong khi đầu không đổi.
    band = slice(0, min(S, int(y0 + 1.3 * w0)))
    sil_b = sil_img[band]
    # Phóng quanh ĐỈNH đầu (không phụ thuộc tư thế): tư thế nghỉ làm chân/thân đổi chiều cao chút ít, phóng
    # quanh tâm người thì đầu trôi theo (r127: dịch chạm biên dò 10 px).
    best = None
    cx, cy = (ib[0] + ib[2]) / 2, ib[1]

    def score(m0, ds, dx, dy):
        A = np.float32([[ds, 0, (1 - ds) * cx + dx], [0, ds, (1 - ds) * cy + dy]])
        m = cv2.warpAffine(m0, A, (S, S), flags=cv2.INTER_NEAREST)[band]
        return float((m & sil_b).sum()) / max(float((m | sil_b).sum()), 1.0)

    for s in (1, -1):  # s=1: mặt trước hướng -Y (camera ở -Y); s=-1: hướng +Y
        sc0 = (ib[3] - ib[1]) / Hm
        u0 = s * co[:, 0] * sc0
        ox0 = cx - (u0.min() + u0.max()) / 2
        oy0 = ib[1] + hi[2] * sc0
        U0, V0 = u0 + ox0, -co[:, 2] * sc0 + oy0
        pts = np.stack([U0[tv], V0[tv]], -1).round().astype(np.int32)
        m0 = np.zeros((S, S), np.uint8)
        for p in pts:
            cv2.fillConvexPoly(m0, p, 1)
        # Thô rồi tinh: ±8% / ±24 px bước 0,02 / 4 px, rồi ±0,01 / ±3 px quanh điểm tốt nhất.
        c = max(((score(m0, ds, dx, dy), ds, dx, dy) for ds in np.arange(0.92, 1.081, 0.02)
                 for dx in range(-24, 25, 4) for dy in range(-24, 25, 4)))
        c = max(((score(m0, c[1] + e, c[2] + dx, c[3] + dy), c[1] + e, c[2] + dx, c[3] + dy) for e in (-0.01, 0, 0.01)
                 for dx in range(-3, 4) for dy in range(-3, 4)))
        if best is None or c[0] > best[0]:
            best = (*c[:1], s, *c[1:], U0, V0)
    iou, s, ds, dx, dy, U0, V0 = best
    U = ds * (U0 - cx) + cx + dx
    V = ds * (V0 - cy) + cy + dy
    depth = s * co[:, 1]          # nhỏ = gần camera
    front = -s * fn[:, 1]
    stats = {"iouHead": round(iou, 4), "facing": "-Y" if s == 1 else "+Y", "scale": round(float(ds), 3), "shift": [int(dx), int(dy)],
             "faceBoxPx": [x0, y0, w0, h0]}
    if iou < 0.85:
        return {**stats, "skipped": "silhouette does not match the front view"}

    # --- z-buffer: mọi tam giác chạm khung mặt, vẽ xa trước gần sau ---
    pad = 12
    tu, tvv = U[tv], V[tv]
    near_box = (tu.max(1) > x0 - pad) & (tu.min(1) < x0 + w0 + pad) & (tvv.max(1) > y0 - pad) & (tvv.min(1) < y0 + h0 + pad)
    depth_t = depth[tv].mean(1)
    idmap = np.full((S, S), -1, np.int32)
    pts = np.stack([tu, tvv], -1).round().astype(np.int32)
    occ = np.nonzero(near_box)[0]
    for t in occ[np.argsort(-depth_t[occ])]:
        cv2.fillConvexPoly(idmap, pts[t], int(t))

    TW, TH = img.size
    px = np.empty(TW * TH * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(TH, TW, 4)  # hàng dưới lên; hàng = v·TH, không lật
    old = px[..., :3].copy()
    new = old.copy()
    wsum = np.zeros((TH, TW), np.float32)
    cu, cv_ = tu.mean(1), tvv.mean(1)
    cand = np.nonzero(near_box & (front > FACE_FACING[0]) & (cu > x0 - pad) & (cu < x0 + w0 + pad) & (cv_ > y0 - pad) & (cv_ < y0 + h0 + pad))[0]
    for t in cand:
        tuv = uv[tl[t]] * [TW, TH]
        mn = np.maximum(np.floor(tuv.min(0)).astype(int), 0)
        mx = np.minimum(np.ceil(tuv.max(0)).astype(int), [TW - 1, TH - 1])
        if (mx < mn).any():
            continue
        gx, gy = np.meshgrid(np.arange(mn[0], mx[0] + 1) + 0.5, np.arange(mn[1], mx[1] + 1) + 0.5)
        a, b_, c = tuv
        den = (b_[1] - c[1]) * (a[0] - c[0]) + (c[0] - b_[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        l1 = ((b_[1] - c[1]) * (gx - c[0]) + (c[0] - b_[0]) * (gy - c[1])) / den
        l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        if not inside.any():
            continue
        i0, i1, i2 = tv[t]
        pu = l1 * U[i0] + l2 * U[i1] + l3 * U[i2]
        pv = l1 * V[i0] + l2 * V[i1] + l3 * V[i2]
        pd = l1 * depth[i0] + l2 * depth[i1] + l3 * depth[i2]
        iu = np.clip(pu.round().astype(int), 0, S - 1)
        iv = np.clip(pv.round().astype(int), 0, S - 1)
        own = idmap[iv, iu]
        vis = (own == t) | ((own >= 0) & (np.abs(depth_t[np.maximum(own, 0)] - pd) < 0.006 * Hm))
        w = fm[iv, iu] * float(np.clip((front[t] - FACE_FACING[0]) / (FACE_FACING[1] - FACE_FACING[0]), 0, 1)) * (inside & vis)
        col = cv2.remap(view, pu.astype(np.float32), pv.astype(np.float32), cv2.INTER_LINEAR) / 255.0
        sl = (slice(mn[1], mx[1] + 1), slice(mn[0], mx[0] + 1))
        up = w > wsum[sl]
        new[sl] = np.where(up[..., None], col * w[..., None] + old[sl] * (1 - w[..., None]), new[sl])
        wsum[sl] = np.maximum(wsum[sl], w)
    hit = wsum > 0.01
    if not hit.any():
        return {**stats, "skipped": "no texel received the face"}

    # --- loang phần chênh ra mọi texel KHÔNG thuộc tam giác ngoài vùng mặt: khe UV giữa các đảo, và texel
    # của tam giác mảnh hơn một texel (gờ quanh mắt cũ — tâm texel không lọt tam giác nào nên giữ màu cũ, thành
    # vòng cung mảnh dưới mắt ở r125). Không lấn đảo của tam giác khác — bài học r114 ở `sleeve_skin_fix`.
    cov = np.zeros((TH, TW), np.uint8)
    rest = np.ones(nt, bool)
    rest[cand] = False
    for q in (uv[tl[rest]] * [TW, TH]).round().astype(np.int32):
        cv2.fillConvexPoly(cov, q, 1)
    cov = cov.astype(bool)
    delta = np.where(hit[..., None], new - old, 0).astype(np.float32)
    have = hit.astype(np.float32)
    gutter = 0
    k3 = np.ones((3, 3), np.float32)
    for _ in range(4):
        sd = cv2.filter2D(delta, -1, k3, borderType=cv2.BORDER_CONSTANT)
        sw = cv2.filter2D(have, -1, k3, borderType=cv2.BORDER_CONSTANT)
        grow = (sw > 0) & (have == 0) & ~cov
        if not grow.any():
            break
        delta[grow] = sd[grow] / sw[grow][:, None]
        have[grow] = 1
        gutter += int(grow.sum())
    new = np.where((have > 0)[..., None], old + delta, old)
    px[..., :3] = np.clip(new, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()
    return {**stats, "texels": int(hit.sum()), "texelsFull": int((wsum > 0.99).sum()), "gutter": gutter}


def limb_weight_fix(bw, idx: dict[str, int]):
    """Bỏ trọng số RÒ sang chuỗi xương không liên quan, rồi chuẩn hoá lại. Chỉ XOÁ, không thêm.

    Mesh A-pose: bàn tay nằm sát đùi, đai áo buông cạnh tay — MIA gán cho đỉnh ở đó một phần trọng số
    của xương bên kia khe hở. Đưa tay lên T-pose (hay chạy) là đỉnh bị kéo thành dải nối tay với thân
    (r17). Luật theo xương TRỘI của từng đỉnh:
      - trội ở chuỗi tay bên X  → chỉ giữ chuỗi tay X + vai X (+ Spine2 nếu trội là Arm/Shoulder)
      - trội ở chuỗi chân bên X → chỉ giữ chuỗi chân X (+ Hips nếu trội là UpLeg)
      - trội ở thân/đầu         → bỏ cẳng tay, bàn tay, ngón, cẳng chân, bàn chân
    """
    import numpy as np

    name = {v: k.split(":", 1)[1] for k, v in idx.items()}
    n_b = bw.shape[1]

    def side_chain(b: str) -> tuple[str, str] | None:
        for s in ("Left", "Right"):
            if b.startswith(s):
                rest = b[len(s):]
                if rest.startswith(("Arm", "ForeArm", "Hand", "Shoulder")):
                    return s, "arm"
                if rest.startswith(("UpLeg", "Leg", "Foot", "ToeBase", "Toe")):
                    return s, "leg"
        return None

    chains = [side_chain(name[i]) for i in range(n_b)]
    allow = np.ones((n_b, n_b), dtype=bool)  # allow[dominant, bone]
    for d in range(n_b):
        cd = chains[d]
        for b in range(n_b):
            cb = chains[b]
            nb = name[b]
            if cd is None:  # thân / đầu
                allow[d, b] = cb is None or nb.endswith(("Shoulder", "Arm", "UpLeg")) and not nb.endswith("ForeArm")
            elif cd[1] == "arm":
                ok = cb is not None and cb == cd
                if name[d].endswith(("Shoulder", "Arm")) and not name[d].endswith("ForeArm"):
                    ok = ok or nb in ("Spine2", "Spine1", "Neck")
                allow[d, b] = ok
            else:  # leg
                ok = cb is not None and cb == cd
                if name[d].endswith("UpLeg"):
                    # Đáy quần / vạt áo giữa hai chân CẦN trộn hai đùi: cấm thì hai đỉnh sát nhau mỗi bên 0,95 một đùi,
                    # tách chân là xé (r119: max giãn Jump 11,5 → 82,5).
                    ok = ok or nb in ("Hips", "Spine") or nb.endswith("UpLeg")
                allow[d, b] = ok
    dom = bw.argmax(1)
    mask = allow[dom]
    # Đầu và tay không kề nhau trên chuỗi xương: đỉnh theo Head ≥ 0,25 mà còn theo vai/tay là TÓC đè lên vai — tay vung
    # là kéo lọn tóc thành mảng chĩa ra (co-be-vo-sinh-hong r33/r34 Walk: Head 0,5 + RightShoulder/RightArm sau vai).
    hi = idx.get("mixamorig:Head")
    if hi is not None:
        arm_b = np.array([c is not None and c[1] == "arm" for c in chains])
        mask = mask & ~((bw[:, hi] >= 0.25)[:, None] & arm_b[None, :])
    removed = float((bw * ~mask).sum() / max(bw.sum(), 1e-9))
    touched = int(((bw * ~mask) > 1e-3).any(1).sum())
    out = bw * mask
    s = out.sum(1, keepdims=True)
    out = np.where(s > 1e-9, out / np.maximum(s, 1e-9), np.eye(n_b)[dom])
    return out.astype(bw.dtype), {"removedWeightShare": round(removed, 4), "vertsTouched": touched, "verts": int(bw.shape[0])}


def main() -> int:
    try:
        job = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        emit("error", message=f"job is not JSON: {e}")
        return 1

    rt = MANIFEST["runtime"]
    mia_dir = Path(os.environ.get(rt["dirEnv"]) or rt["dir"])
    models_root = Path(str(job.get("modelsRoot") or os.environ.get("ARM_MODELS_ROOT") or "E:/ai-models"))
    bones = models_root / "rig/mixamo/bones.fbx"
    if not bones.is_file():
        emit("error", message=f"Mixamo skeleton template missing: {bones}. The dataset jasongzy/Mixamo is gated on "
                              "Hugging Face — accept it, then run `python arms/mia-rig/fetch.py`.")
        return 1
    for need in ("bw_joints.pth", "joints_coarse.pth", "pose.pth"):
        if not (mia_dir / "output/best/v2" / need).is_file():
            emit("error", message=f"missing {mia_dir / 'output/best/v2' / need} — run fetch.py and check the junction")
            return 1
    os.environ.setdefault("HY3DGEN_MODELS", str(models_root / "rig/hy3dgen"))

    src = Path(str(job.get("mesh") or ""))
    if not src.is_file():
        emit("error", message=f"mesh not found: {src}")
        return 1
    out = Path(str(job.get("out") or "rig"))
    out.mkdir(parents=True, exist_ok=True)
    work = out / "mesh.glb"
    if src.resolve() != work.resolve():
        shutil.copyfile(src, work)
    # Mesh cho MIA + bone heat: bản ĐÃ DỌN (một vỏ kín) nếu `prep` — xem prep.py. Trọng số chép về mesh gốc.
    prep_cfg = job.get("prep", True)
    prep_on = prep_cfg is not False and prep_cfg is not None
    prep_stats = None
    mia_in = work
    if prep_on and not job.get("predFrom"):
        import subprocess

        pj = dict(prep_cfg) if isinstance(prep_cfg, dict) else {}
        pj.update(mesh=str(work), out=str(out / "prep.glb"), bake=False)
        r = subprocess.run([sys.executable, str(HERE / "prep.py"), json.dumps(pj)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        rows = [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]
        done = [x for x in rows if x.get("event") == "done"]
        if r.returncode != 0 or not done:
            err = [x for x in rows if x.get("event") == "error"]
            emit("error", message=f"prep failed: {(err[0]['message'] if err else r.stderr[-800:])}")
            return 1
        prep_stats = done[0].get("stats")
        mia_in = out / "prep.glb"
        log(f"prep: {prep_stats}")

    rest_pose = job.get("restPose") or None
    no_fingers = bool(job.get("noFingers"))
    retarget = bool(job.get("retarget"))
    inplace = job.get("inplace", True) is not False
    canonical = job.get("canonical", True) is not False
    weight_fix = job.get("weightFix", True) is not False
    # Tỉ lệ đầu/chiều cao muốn đưa mesh về trước khi MIA dự đoán; 0/false = không co. Xem `HeadShrink`.
    head_target = float(job.get("headTarget", 0.2) or 0)
    # Số vòng mượt vùng tay hàn vào thân (0 = tắt) — xem `arm_seam_smooth`; bàn tay một khối chỉ khi bỏ ngón.
    arm_smooth = int(job.get("armSmooth", 150) or 0)
    leg_smooth = int(job.get("legSmooth", 0) or 0)
    seed = int(job.get("seed", 0) or 0)
    arm_space_deg = float(job.get("armSpace", 30) or 0)
    torso_clear = job.get("torsoClear", True) is not False
    knee_up = float(job.get("kneeRaise") or 0)
    sleeve_fix = job.get("sleeveSkinFix") or 0
    sleeve_fix = 0.032 if sleeve_fix is True else float(sleeve_fix)
    face_ref = bool(job.get("faceFromRef"))
    # Nguồn trọng số: "heat" = bone heat của Blender trên proxy (khớp của MIA) — xem `heat_weights`;
    # "mia" = trọng số MIA + các lớp vá (weightFix/armSmooth).
    weights_mode = str(job.get("weights") or "skintokens")
    if weights_mode == "skintokens" and not Path(str((MANIFEST.get("skintokens") or {}).get("python") or "")).is_file():
        # Máy chưa dựng venv SkinTokens (xem docs/char3d.md) → lùi về bone heat, ghi rõ trong info.json.
        log("skintokens venv missing — falling back to bone heat")
        weights_mode = "heat"
    pred_from = str(job.get("predFrom") or "") or None
    skin_from = str(job.get("skinFrom") or "") or None
    if skin_from and not Path(skin_from).is_file():
        emit("error", message=f"skinFrom not found: {skin_from}")
        return 1
    if pred_from and not Path(pred_from).is_file():
        emit("error", message=f"predFrom not found: {pred_from}")
        return 1
    rigid_hands = job.get("rigidHand", no_fingers) is not False and no_fingers
    wf_stats: dict = {}
    anims = [a for a in (job.get("animations") or []) if a.get("path") and Path(a["path"]).is_file()]

    # MIA viết cho Linux: `with tempfile.NamedTemporaryFile(suffix=".glb") as f: mesh.export(f.name)` —
    # Windows không cho mở lại file đang mở → PermissionError (đã dính r14). Thay bằng bản tạo tên rồi
    # đóng ngay, xoá khi ra khỏi `with`. File tạm vào thư mục ra (ổ E), không vào %TEMP% trên C.
    import contextlib
    import tempfile

    tmp_dir = out / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    tempfile.tempdir = str(tmp_dir)

    @contextlib.contextmanager
    def _named_tmp(suffix: str = "", prefix: str = "tmp", dir: str | None = None, **_kw):
        fd, name = tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=dir)
        os.close(fd)

        class _F:
            pass

        f = _F()
        f.name = name
        try:
            yield f
        finally:
            with contextlib.suppress(OSError):
                os.remove(name)

    tempfile.NamedTemporaryFile = _named_tmp  # type: ignore[assignment]

    ph = Phase()
    sys.path.insert(0, str(mia_dir))
    cwd = os.getcwd()
    try:
        with ph("import"):
            os.chdir(mia_dir)
            import numpy as np
            import torch
            import app_v2 as A  # noqa: N812

            # `prepare_input`… trả dict khoá bằng component Gradio. Chỉ cần chúng tồn tại.
            for k in ("state", "output_joints_coarse", "output_normed_input", "output_sample", "output_joints",
                      "output_bw", "output_rest_vis", "output_rest_lbs", "output_anim_vis", "output_anim"):
                setattr(A, k, k)
            A.change_Model3D = lambda *a, **k: None
            if canonical:
                # Mesh vào ĐÃ đứng chuẩn (Pixal3D: Y lên, mặt hướng +Z — đúng quy ước Mixamo). Bước
                # "xoay về khung hông" của MIA dựng khung từ 3 khớp THÔ (Hips, Left/RightUpLeg); với chibi
                # chân ngắn quần phồng ba khớp đó lệch, khung nghiêng ~30°, và model tinh (train trên người
                # đứng thẳng) đoán rác trên thân nghiêng (r16: Neck lệch x −0,28, hai bàn chân cùng một
                # phía). Giữ phần tịnh tiến (Hips về gốc), bỏ phần xoay.
                def _hips_translate(hips, rightupleg, leftupleg):
                    m = torch.eye(4, device=hips.device, dtype=hips.dtype).repeat(hips.shape[0], 1, 1)
                    m[:, :3, 3] = -hips
                    return m

                A.get_hips_transform = _hips_translate
        if pred_from:
            # Dùng lại dự đoán đã lưu: bỏ MIA (không GPU), chỉ chạy các lớp vá + bind. MIA KHÔNG tất định
            # trên GPU kể cả khi đặt seed (r29 vs r30: lớp `distance` 4017 vs 1129 đỉnh), nên so bật/tắt một
            # lớp vá chỉ có nghĩa khi cả hai cùng một dự đoán.
            import pickle

            with ph("load-pred"):
                raw = pickle.loads(Path(pred_from).read_bytes())
            db = A.DB()
            for k in ("mesh", "verts", "joints", "joints_tail", "bw", "pose"):
                setattr(db, k, raw[k])
            shrink_info, flipped, normals_n = raw["headShrink"], {"faces": raw["windingFlipped"]}, raw["normals"]
            display, prep_stats = raw.get("display"), raw.get("prep")
            # Pickle mang theo mesh CÓ TEXTURE của lượt cũ. Mesh vào cùng hình khối mà texture mới (`retexture`,
            # r67/r68: rig ra tóc ám hồng của r62) → lấy UV + vật liệu của mesh vào hiện tại.
            tgt = display["mesh"] if display is not None else db.mesh
            try:
                cur = A.trimesh.load(str(work), force="mesh")
                if len(cur.vertices) == len(tgt.vertices) and hasattr(cur.visual, "uv"):
                    tgt.visual = cur.visual
                    log("predFrom: texture taken from the current mesh")
                else:
                    log(f"predFrom: vertex count differs ({len(cur.vertices)} vs {len(tgt.vertices)}) — texture of the old run kept")
            except Exception as e:
                log(f"predFrom: texture swap failed: {e}")
            emit("loaded", ms=int((time.time() - T0) * 1000), device="cpu", predFrom=str(pred_from))
        else:
            with ph("load-models"):
                A.init_models()
                os.chdir(mia_dir)
            emit("loaded", ms=int((time.time() - T0) * 1000), device=str(A.device))

            db = A.DB()
            shrink = None
            flipped = {"faces": 0}
            stored: dict = {"n": None}
            with ph("prepare"):
                # Lấy mẫu điểm trên mesh dùng RNG chung. Không đặt seed thì mỗi lượt một bộ điểm → dự đoán khác
                # nhau (r27 vs r28: lớp `distance` chuyển 1448 vs 8268 đỉnh) — so vá trước/sau mất nghĩa.
                A.fix_random(seed)
                real_load = A.trimesh.load
                v_orig = None

                def _load(path, *a, **k):
                    nonlocal shrink, v_orig
                    m = real_load(path, *a, **k)
                    if isinstance(m, A.trimesh.Trimesh):
                        stored["n"] = glb_normals(str(path))
                        flipped["faces"] = fix_winding(m, stored["n"])
                        log(f"winding: flipped {flipped['faces']} faces to match stored normals")
                    if head_target and isinstance(m, A.trimesh.Trimesh):
                        v_orig = np.asarray(m.vertices, dtype=np.float64).copy()
                        shrink = HeadShrink(v_orig, head_target)
                        log(f"head-shrink: {shrink.info()}")
                        if shrink.active:
                            m.vertices = shrink.apply(v_orig)
                    return m

                A.trimesh.load = _load
                try:
                    A.prepare_input(str(mia_in), False, 0.0, db, export_temp=False)
                finally:
                    A.trimesh.load = real_load
            with ph("coarse-joints"):
                A.preprocess(db)
            with ph("infer"):
                A.infer(True, db)
            with ph("post"):
                A.vis(True, "LeftArm", no_fingers, False, db)
            if shrink is not None and shrink.active:
                with ph("head-restore"):
                    # Về lại hệ gốc: đỉnh gốc qua đúng phép chuẩn hoá MIA đã dùng; khớp thì ngược phép co.
                    gt = db.global_transform
                    to_n = lambda P: gt.transform_points(torch.as_tensor(P, dtype=torch.float32)[None]).squeeze(0).cpu().numpy()  # noqa: E731
                    from_n = lambda P: gt.inverse().transform_points(torch.as_tensor(P, dtype=torch.float32)[None]).squeeze(0).cpu().numpy()  # noqa: E731
                    vn = to_n(v_orig)
                    db.mesh.vertices = vn
                    db.verts = vn
                    db.joints = to_n(shrink.undo(from_n(np.asarray(db.joints)))).astype(np.float32)
                    db.joints_tail = to_n(shrink.undo(from_n(np.asarray(db.joints_tail)))).astype(np.float32)
            shrink_info = shrink.info() if shrink else None
            normals_n = None
            if stored["n"] is not None and len(stored["n"]) == len(db.mesh.vertices):
                nn = db.global_transform.transform_normals(torch.as_tensor(stored["n"], dtype=torch.float32)[None]).squeeze(0).cpu().numpy()
                normals_n = nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
            display = None
            if mia_in != work:
                # Mesh GỐC (có texture) qua đúng phép chuẩn hoá MIA đã dùng cho bản đã dọn — cùng hệ toạ độ.
                gt = db.global_transform
                om = A.trimesh.load(str(work), force="mesh")
                on = glb_normals(str(work))
                fix_winding(om, on)
                pv = gt.transform_points(torch.as_tensor(np.asarray(om.vertices), dtype=torch.float32)[None]).squeeze(0).cpu().numpy()
                om.vertices = pv
                onn = None
                if on is not None and len(on) == len(pv):
                    onn = gt.transform_normals(torch.as_tensor(on, dtype=torch.float32)[None]).squeeze(0).cpu().numpy()
                    onn /= np.maximum(np.linalg.norm(onn, axis=1, keepdims=True), 1e-9)
                # Đỉnh TÓC RỦ prep.py đã cắt khỏi bản cho MIA (`prep_hair.npy`, toạ độ Blender Z lên → glTF Y lên) —
                # khớp theo vị trí với mesh gốc; lúc chép trọng số, tóc chỉ nhận xương thân/cổ/đầu.
                hair_mask = None
                hn = out / "prep_hair.npy"
                if hn.is_file():
                    from scipy.spatial import cKDTree

                    hp = np.load(hn).astype(np.float64)
                    hp = np.stack([hp[:, 0], hp[:, 2], -hp[:, 1]], 1)
                    hpn = gt.transform_points(torch.as_tensor(hp, dtype=torch.float32)[None]).squeeze(0).cpu().numpy()
                    hd, _ = cKDTree(hpn).query(pv, k=1)
                    hair_mask = hd < 1e-4 * float(np.ptp(pv[:, 1]))
                    log(f"hair-cut: {int(hair_mask.sum())} source verts follow torso/neck/head")
                display = {"mesh": om, "verts": pv, "normals": onn, "hairMask": hair_mask}
            # Dự đoán THÔ (trước mọi lớp vá trọng số) — `predFrom` của lượt sau dùng lại.
            import pickle

            (out / "mia_raw.pkl").write_bytes(pickle.dumps({
                "mesh": db.mesh, "verts": np.asarray(db.verts), "joints": np.asarray(db.joints),
                "joints_tail": np.asarray(db.joints_tail), "bw": np.asarray(db.bw).astype(np.float32), "pose": db.pose,
                "headShrink": shrink_info, "windingFlipped": flipped["faces"], "normals": normals_n, "seed": seed, "display": display, "prep": prep_stats},
                protocol=pickle.HIGHEST_PROTOCOL))
        knee_stats = knee_raise(db, dict(A.BONES_IDX_DICT), knee_up) if knee_up else False
        if knee_up:
            log(f"knee raise: {knee_stats}")
        if weights_mode == "heat":
            with ph("heat-weights"):
                idx = dict(A.BONES_IDX_DICT)
                bnames = [k for k, _ in sorted(idx.items(), key=lambda kv: kv[1])]
                keep = [i for i, n in enumerate(bnames)
                        if not (no_fingers and any(f in n for f in ("Thumb", "Index", "Middle", "Ring", "Pinky")))]
                vv = np.asarray(db.verts).reshape(-1, 3)
                args_ = (vv, np.asarray(db.mesh.faces), np.asarray(db.joints), np.asarray(db.joints_tail),
                         bnames, list(A.KINEMATIC_TREE.parent_indices), keep)
                # Proxy voxel 0,006·H trước (lấp khe → bone heat thấy xương rõ hơn; r52 tốt hơn r55). Trên vỏ prep
                # đã decimate, chỗ mỏng có thể vỡ thành nhiều mảnh (r53: 569, chép P99 = 11% chiều cao) → khi đó
                # tính thẳng trên vỏ prep (r56: p999 9–41 → 4–5,8).
                bw, hs = heat_weights(*args_, voxel_frac=0.006)
                if display is not None and hs.get("transferDistP99OverH", 0) > 0.03:
                    bad = dict(hs)
                    bw, hs = heat_weights(*args_, voxel_frac=0.0)
                    hs["voxelRejected"] = bad
                wf_stats = {"heat": hs}
                if rigid_hands:
                    bw, wf_stats["rigidHand"] = rigid_hand(bw, vv, np.asarray(db.joints), idx)
                db.bw = bw
                log(f"heat weights: {wf_stats}")
        elif weights_mode == "skintokens":
            with ph("skintokens"):
                # Khớp của MIA (22 xương, bỏ ngón), trọng số do TokenRig sinh — st_skin.py chạy trong venv riêng.
                # Nhả GPU của MIA trước: hai model cùng nằm trong 12 GB là tràn.
                for k in ("model_bw", "model_joints", "model_coarse", "model_pose"):
                    if hasattr(A, k):
                        setattr(A, k, None)
                import gc
                import subprocess

                gc.collect()
                torch.cuda.empty_cache()
                idx = dict(A.BONES_IDX_DICT)
                bnames = [k for k, _ in sorted(idx.items(), key=lambda kv: kv[1])]
                keep = [i for i, n in enumerate(bnames)
                        if not any(f in n for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"))]
                par_all = list(A.KINEMATIC_TREE.parent_indices)
                pos = {b: j for j, b in enumerate(keep)}

                def kept_parent(i):
                    p_ = par_all[i]
                    while p_ is not None and p_ >= 0 and p_ not in pos:
                        p_ = par_all[p_]
                    return pos[p_] if p_ is not None and p_ >= 0 else -1

                vv = np.asarray(db.verts).reshape(-1, 3)
                st_in, st_out = out / "st_in.npz", out / "st_out.npz"
                np.savez(st_in, vertices=vv.astype(np.float32), faces=np.asarray(db.mesh.faces),
                         joints=np.asarray(db.joints)[keep].astype(np.float32),
                         parents=np.array([kept_parent(i) for i in keep]), names=np.array([bnames[i] for i in keep]))
                if skin_from:
                    # Dùng lại trọng số của lượt trước: TokenRig lấy mẫu (top-k) KHÔNG tất định trên GPU kể cả
                    # đặt seed — r61 vs r62 cùng dự đoán, 16% đỉnh lệch > 0,1. Phải cùng predFrom (cùng đỉnh).
                    S = np.load(skin_from)["skin"]
                    if S.shape != (len(vv), len(keep)):
                        raise RuntimeError(f"skinFrom shape {S.shape} != {(len(vv), len(keep))} — needs the same predFrom")
                    shutil.copyfile(skin_from, st_out)
                    done = [{"skinFrom": skin_from}]
                else:
                    stc = MANIFEST.get("skintokens") or {}
                    env = dict(os.environ, SKINTOKENS_DIR=str(stc.get("dir") or ""), ST_SEED=str(seed))
                    r = subprocess.run([str(stc.get("python")), str(HERE / "st_skin.py"), str(st_in), str(st_out)],
                                       capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
                    rows = [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]
                    done = [x for x in rows if x.get("event") == "done"]
                    if r.returncode != 0 or not done:
                        err = [x for x in rows if x.get("event") == "error"]
                        raise RuntimeError(f"skintokens failed: {err[0]['message'] if err else r.stderr[-1500:]}")
                    S = np.load(st_out)["skin"]
                bw = np.zeros((len(vv), len(bnames)), np.float32)
                bw[:, keep] = S
                wf_stats = {"skintokens": {k: done[0].get(k) for k in ("ms", "peakVramMiB", "missing", "outJoints", "skinFrom")}}
                if weight_fix:
                    # Luật chuỗi cũng cần cho SkinTokens: r105/r108 có đỉnh sau cổ tay phải dính 0,02–0,06 RightToeBase —
                    # clip đá/nhảy kéo cổ tay theo bàn chân, giãn ×8–12 (64/80 clip có cạnh vùng tay giãn > 3×).
                    bw, wf_stats["limb"] = limb_weight_fix(bw, idx)
                if leg_smooth:
                    bw, wf_stats["legSeam"] = arm_seam_smooth(bw, np.asarray(db.mesh.faces), idx, iters=leg_smooth,
                                                              chains=LEG_CHAINS)
                if rigid_hands:
                    bw, wf_stats["rigidHand"] = rigid_hand(bw, vv, np.asarray(db.joints), idx)
                db.bw = bw
                log(f"skintokens: {wf_stats}")
        elif weight_fix:
            with ph("weight-fix"):
                # Ngưỡng theo chiều cao của mesh ĐANG bind (sau khi trả đầu về): đo r19, near 0,04 / far 0,1
                # làm sạch tay trái (UpLeg 0,15 → 0,02) và hết đỉnh dưới cổ theo Head; xoá 2,7% trọng số.
                vv = np.asarray(db.verts).reshape(-1, 3)
                hh = float(vv[:, 1].max() - vv[:, 1].min())
                bw1, st1 = dist_weight_fix(np.asarray(db.bw), vv, np.asarray(db.joints), np.asarray(db.joints_tail),
                                           list(A.KINEMATIC_TREE.parent_indices), hh)
                bw2, st2 = limb_weight_fix(bw1, dict(A.BONES_IDX_DICT))
                bw3, st3 = island_fix(bw2, np.asarray(db.mesh.faces))
                wf_stats = {"distance": st1, "limb": st2, "island": st3}
                if arm_smooth:
                    bw3, wf_stats["armSeam"] = arm_seam_smooth(bw3, np.asarray(db.mesh.faces), dict(A.BONES_IDX_DICT), iters=arm_smooth)
                # Sau mượt: mượt làm nhoè ranh cổ tay, nên khoá bàn tay SAU cùng.
                if rigid_hands:
                    bw3, wf_stats["rigidHand"] = rigid_hand(bw3, vv, np.asarray(db.joints), dict(A.BONES_IDX_DICT))
                db.bw = bw3
                log(f"weight-fix: {wf_stats}")
        if display is not None:
            with ph("prep-transfer"):
                # Trọng số tính trên bản đã dọn → mesh gốc: 4 đỉnh gần nhất, nghịch khoảng cách. Hai lớp của vỏ
                # Pixal3D nằm hai bên mặt đã dọn → nhận cùng trọng số, đi cùng nhau, không xé.
                from scipy.spatial import cKDTree

                dd, ii = cKDTree(np.asarray(db.verts).reshape(-1, 3)).query(display["verts"], k=4)
                w = 1 / np.maximum(dd, 1e-9)
                bwd = (np.asarray(db.bw)[ii] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
                hm = display.get("hairMask")
                idx = dict(A.BONES_IDX_DICT)
                if hm is not None and hm.any() and "mixamorig:Head" in idx and "mixamorig:Spine2" in idx:
                    # Tóc rủ không có trong bản đã dọn → đỉnh gần nhất là vai/tay/lưng. Gán theo chiều dài tóc: sát đường
                    # cắt 100% Head (liền với tóc trên đầu), xuống đuôi tóc chuyển dần sang Spine2 (còn 30% Head).
                    # Chép từ đỉnh thân gần nhất (r32) xé ở đường cắt: Head ↔ Spine2/Hips, p999 tới 18, max 90. Nới vùng tóc
                    # sang đỉnh sát tóc ngoài vỏ (r34) làm p999 Walk 3,3 → 5,9 — đã bỏ.
                    hy = display["verts"][hm][:, 1]
                    top, bot = float(hy.max()), float(hy.min())
                    d = np.clip((top - hy) / max(top - bot, 1e-9), 0, 1)
                    hb = np.zeros((len(hy), bwd.shape[1]), dtype=bwd.dtype)
                    hb[:, idx["mixamorig:Head"]] = 1 - 0.7 * d
                    hb[:, idx["mixamorig:Spine2"]] = 0.7 * d
                    bwd[hm] = hb
                    wf_stats["hairCut"] = {"verts": int(hm.sum())}
                # Xương chuỗi TAY ở xa đỉnh > 0,12·H → bỏ (tay áo rộng nhất cách xương ~0,07·H). Chép 4 đỉnh gần nhất cho
                # lọn tóc đè sau vai trọng số của lưng-vai (RightArm 0,59 ở 0,17·H sau khớp vai) → vung tay kéo lọn tóc
                # thành mảng chĩa ngang (co-be-vo-sinh-hong r33–r35 Walk). Đường MIA có dist_weight_fix; SkinTokens thì không.
                jn, jt = np.asarray(db.joints), np.asarray(db.joints_tail)
                hhv = float(np.ptp(np.asarray(db.verts)[:, 1]))
                import re

                arm_ids = [i for k, i in idx.items() if i < bwd.shape[1]
                           and re.match(r"(Left|Right)(Shoulder|Arm|ForeArm|Hand)", k.split(":", 1)[-1])]
                Vd = display["verts"]
                cut = 0
                for b in arm_ids:
                    a, t = jn[b], jt[b]
                    ab = t - a
                    s = np.clip(((Vd - a) @ ab) / max(float(ab @ ab), 1e-12), 0, 1)
                    far_b = np.linalg.norm(Vd - (a + s[:, None] * ab), axis=1) > 0.12 * hhv
                    far_b &= bwd[:, b] > 0
                    cut += int(far_b.sum())
                    keep_sum = bwd[far_b].sum(1) - bwd[far_b, b]
                    ok = keep_sum > 1e-6
                    rows = np.nonzero(far_b)[0][ok]
                    bwd[rows, b] = 0
                    bwd[rows] /= bwd[rows].sum(1, keepdims=True)
                wf_stats["armFar"] = {"weightsCut": cut}
                if weight_fix:
                    # Chép 4 đỉnh gần nhất có thể trộn lại hai chuỗi ở chỗ hai phần nằm sát nhau — lọc lần nữa.
                    bwd, wf_stats["limbAfterTransfer"] = limb_weight_fix(bwd, dict(A.BONES_IDX_DICT))
                if rigid_hands:
                    bwd, _ = rigid_hand(bwd, display["verts"], np.asarray(db.joints), dict(A.BONES_IDX_DICT))
                hh = float(np.ptp(np.asarray(db.verts)[:, 1]))
                wf_stats["prepTransfer"] = {"distP99OverH": round(float(np.percentile(dd[:, 0], 99)) / hh, 4)}
                db.mesh, db.verts, db.bw, normals_n = display["mesh"], display["verts"], bwd.astype(np.float32), display["normals"]
        peak = torch.cuda.max_memory_allocated() // 2**20 if torch.cuda.is_available() else None
        # Dự đoán thô của MIA — để soát từng xương khi rig hỏng (pose sai hay trọng số sai).
        np.savez_compressed(out / "mia_pred.npz", joints=np.asarray(db.joints), joints_tail=np.asarray(db.joints_tail),
                            pose=np.asarray(db.pose) if db.pose is not None else np.zeros(0), bw=np.asarray(db.bw),
                            verts=np.asarray(db.verts), faces=np.asarray(db.mesh.faces), bones=np.array(list(dict(A.BONES_IDX_DICT).keys())))

        if normals_n is not None:
            # Pháp tuyến GỐC của Pixal3D đi theo mesh sang Blender (trimesh ghi NORMAL khi export, Blender
            # nạp thành custom normal). Không có bước này Blender tính lại từ winding → mảng đen (r22–r24).
            db.mesh.vertex_normals = normals_n

        with ph("blender-bind"):
            from argparse import Namespace

            import app_blender
            import util.blender_utils as bu
            from util.blender_utils import bpy

            data = dict(mesh=db.mesh, gs=None, joints=db.joints, joints_tail=db.joints_tail, bw=db.bw, pose=db.pose,
                        bones_idx_dict=dict(A.BONES_IDX_DICT),
                        pose_ignore_list=A.get_pose_ignore_list(rest_pose, None))
            fbx_rest = out / "rest.fbx"
            app_blender.main(Namespace(
                input_path=data, output_path=str(fbx_rest), template_path=A.TEMPLATE_PATH, keep_raw=False,
                rest_path=str(out / "rest.glb"), pose_local=False, reset_to_rest=True, remove_fingers=no_fingers,
                animation_path=None, retarget=False, inplace=inplace))

        arm_obj = bu.get_armature_obj(list(bpy.context.scene.objects))
        mesh_obj = bpy.data.objects.get("mesh") or bu.get_all_mesh_obj(list(bpy.context.scene.objects))[0]
        # Cảnh còn object lạ (một `Icosphere` từ khung mẫu) — xoá TRƯỚC mọi lần xuất, rồi xuất lại rest.glb
        # (app_blender đã xuất bản có Icosphere).
        for o in list(bpy.context.scene.objects):
            if o is not arm_obj and o is not mesh_obj:
                bpy.data.objects.remove(o, do_unlink=True)
        # ROLL chuỗi tay về quy ước Mixamo (trục Z xương chĩa XUỐNG ở T-pose, như khung mẫu và mọi rig tốt). MIA có lúc
        # đoán pose tay XOẮN quanh trục xương (co-be-vo-sinh-hong r45: LeftArm/RightArm ~45°, r32 ~8°); phần xoắn đó nằm
        # lại trong khung nghỉ, clip Mixamo gán theo tên quay trong khung lệch → "buông tay" thành "đưa tay ra trước"
        # (r46 Walk). Đổi roll lúc nghỉ không dời mesh (biến dạng = pose · nghỉ⁻¹ = đơn vị).
        roll_fixed = []
        try:
            from mathutils import Vector

            bpy.ops.object.select_all(action="DESELECT")
            arm_obj.select_set(True)
            bpy.context.view_layer.objects.active = arm_obj
            bpy.ops.object.mode_set(mode="EDIT")
            down = (arm_obj.matrix_world.to_3x3().inverted() @ Vector((0.0, 0.0, -1.0))).normalized()
            for s in ("Left", "Right"):
                for b in ("Shoulder", "Arm", "ForeArm", "Hand"):
                    eb = arm_obj.data.edit_bones.get(f"mixamorig:{s}{b}")
                    if eb is None:
                        continue
                    before = eb.z_axis.copy()
                    eb.align_roll(down)
                    ang = math.degrees(before.angle(eb.z_axis))
                    if ang > 1:
                        roll_fixed.append(f"{s}{b}:{ang:.0f}")
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception as e:  # không chặn cả lượt vì bước chuẩn hoá
            log(f"arm roll fix skipped: {e}")
        log(f"arm roll fix: {roll_fixed or 'none'}")
        sleeve_stats = sleeve_skin_fix(arm_obj, mesh_obj, float(sleeve_fix)) if sleeve_fix else False
        if sleeve_fix:
            log(f"sleeve skin fix: {sleeve_stats}")
        face_stats = face_from_ref(mesh_obj, src.parent / "mesh_views" / "front.png") if face_ref else False
        if face_ref:
            log(f"face from ref: {face_stats}")
        bpy.ops.export_scene.gltf(filepath=str(out / "rest.glb"), check_existing=False, use_selection=False,
                                  export_animations=False, export_rest_position_armature=False)
        # THEO TÊN: app_blender đặt tên mesh nhân vật là "mesh". `get_all_mesh_obj` sắp theo tên nên
        # một object lạ tên "Icosphere" đứng trước và bị lấy nhầm (r18).
        mesh_obj = bpy.data.objects.get("mesh") or bu.get_all_mesh_obj(list(bpy.context.scene.objects))[0]
        clips = []
        arm_space_stats: list[dict] = []
        torso_stats: list[dict] = []
        with ph("animations"):
            if arm_obj.animation_data is None:
                arm_obj.animation_data_create()
            tc = TorsoClearance(arm_obj, mesh_obj) if torso_clear else None
            for i, a in enumerate(anims):
                before = set(bpy.data.actions)
                anim_objs = bu.load_file(a["path"])
                src_arm = bu.get_armature_obj(anim_objs)
                if src_arm is None or src_arm.animation_data is None or src_arm.animation_data.action is None:
                    log(f"no action in {a['path']}")
                    for o in anim_objs:
                        bpy.data.objects.remove(o, do_unlink=True)
                    continue
                act = src_arm.animation_data.action
                if retarget:
                    arm_obj.animation_data.action = act
                    bu.retarget(src_arm, arm_obj, inplace=inplace)
                    act = arm_obj.animation_data.action
                elif inplace:
                    # Khoá dịch chuyển ngang của Hips (giữ nhấp nhô dọc). Mixamo: Hips là bone gốc.
                    for fc in act.fcurves:
                        if fc.data_path == 'pose.bones["mixamorig:Hips"].location' and fc.array_index in (0, 2):
                            v0 = fc.keyframe_points[0].co[1] if fc.keyframe_points else 0
                            for kp in fc.keyframe_points:
                                kp.co[1] = v0
                                kp.handle_left[1] = v0
                                kp.handle_right[1] = v0
                if arm_space_deg:
                    arm_space_stats.append(arm_space(arm_obj, act, arm_space_deg))
                if tc is not None:
                    arm_obj.animation_data.action = act
                    torso_stats.append(tc.apply(act))
                act.name = a.get("name") or Path(a["path"]).stem
                if tc is not None:
                    torso_stats[-1]["clip"] = act.name
                act.use_fake_user = True
                tr = arm_obj.animation_data.nla_tracks.new()
                tr.name = act.name
                start = int(act.frame_range[0])
                tr.strips.new(act.name, start, act)
                arm_obj.animation_data.action = None
                for o in anim_objs:
                    bpy.data.objects.remove(o, do_unlink=True)
                for x in set(bpy.data.actions) - before - {act}:
                    if x.users == 0:
                        bpy.data.actions.remove(x)
                clips.append({"name": act.name, "frames": [int(v) for v in act.frame_range]})
                emit("step", stage="animations", i=i + 1, of=len(anims))

        with ph("export"):
            # Chỉ armature + mesh nhân vật: cảnh còn sót object khác (đã thấy một `Icosphere` lọt vào GLB r15).
            for o in list(bpy.context.scene.objects):
                if o is not arm_obj and o is not mesh_obj:
                    bpy.data.objects.remove(o, do_unlink=True)
            bu.update()
            bpy.ops.export_scene.gltf(filepath=str(out / "rigged.glb"), check_existing=False, use_selection=False,
                                      export_animations=bool(clips), export_animation_mode="NLA_TRACKS",
                                      export_rest_position_armature=True)
            bpy.ops.export_scene.fbx(filepath=str(out / "rigged.fbx"), check_existing=False, use_selection=False,
                                     add_leaf_bones=False, bake_anim=bool(clips), bake_anim_use_nla_strips=True,
                                     bake_anim_use_all_actions=False, path_mode="COPY", embed_textures=True)
            ao_stripped = {f: strip_occlusion(out / f) for f in ("rigged.glb", "rest.glb") if (out / f).is_file()}
            log(f"occlusion stripped: {ao_stripped}")

        bones_n = len(arm_obj.data.bones)
        joints = {b.name: [round(x, 4) for x in (arm_obj.matrix_world @ b.head_local)] for b in arm_obj.data.bones}
        info = {"bones": bones_n, "clips": clips, "restPose": rest_pose, "armRollFixed": roll_fixed, "noFingers": no_fingers, "retarget": retarget,
                "inplace": inplace, "canonical": canonical, "weights": weights_mode, "prep": prep_stats, "weightFix": wf_stats if (weight_fix or weights_mode == "heat") else False,
                "headShrink": shrink_info, "predFrom": str(pred_from) if pred_from else None, "armSpace": arm_space_stats or False, "torsoClear": torso_stats or False, "sleeveSkinFix": sleeve_stats, "faceFromRef": face_stats, "kneeRaise": knee_stats, "windingFlipped": flipped["faces"], "aoStripped": ao_stripped, "verts": len(mesh_obj.data.vertices), "joints": joints, "peakVramMiB": peak,
                "phaseMs": ph.ms, "seed": seed, "miaCommit": rt.get("commit")}
        (out / "info.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
        # Sản phẩm phụ của MIA (que xương, trọng số) — để soát vị trí khớp.
        # Dùng lại dự đoán (`predFrom`) thì MIA không chạy, không có file phụ.
        side = Path(db.output_dir) if getattr(db, "output_dir", None) else None
        for name in ("joints.glb", "bw.glb", "joints_coarse.glb", "rest_lbs.glb"):
            if side is not None and (side / name).is_file():
                shutil.copyfile(side / name, out / name)
        emit("done", path=str(out / "rigged.glb"), fbx=str(out / "rigged.fbx"), rest=str(out / "rest.glb"),
             clips=clips, bones=bones_n, peakVramMiB=peak, phaseMs=ph.ms)
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1
    finally:
        os.chdir(cwd)


if __name__ == "__main__":
    sys.exit(main())

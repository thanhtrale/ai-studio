"""
Cắt sheet ba góc (front | left | back trên nền trắng, MỘT lần sinh) thành ba ảnh rời + đo khớp chéo — chạy bằng
python của arm `mia-rig` (PIL + numpy). Runner gọi sau bước ref `mode: "sheet"`.

    python split_sheet.py '{"sheets": ["…/ref/sheet_0.png", …], "outDir": "…/ref"}'

Cắt bằng cột trắng: dải cột có người, gộp khe < 12 px (tóc/tay lẻ), bỏ dải < 40 px. Đúng 3 dải mới dùng được.
Mỗi góc dán vào canvas vuông nền trắng, GIỮ vị trí dọc (đỉnh/đáy chung giữa các góc) — Pixal3D tự cắt theo mặt nạ.

Khớp chéo (docs/char3d.md "Flow chuẩn"): bề ngang front vs back lệch ≤ 5%, chiều cao ba góc lệch ≤ 3%. Sheet lệch
hơn thì tay/thân hai góc không cùng dáng → mesh hỏng tay áo, bàn tay (log r192).

Đầu ra (`done`): sets: [{index, sheet, views: {front, left, back} | null, check: {segments, widths, heights,
widthDiff, heightDiff, ok}}]
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

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

T0 = time.time()
VIEWS = ("front", "left", "back")
WIDTH_TOL = 0.05
HEIGHT_TOL = 0.03


def emit(event: str, **kw) -> None:
    row = {"event": event, "ms": int((time.time() - T0) * 1000)}
    row.update(kw)
    _PROTO.write(json.dumps(row, ensure_ascii=False) + "\n")
    _PROTO.flush()


def split(path: str, out_dir: Path, index: int) -> dict:
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(int)
    fg = a.min(2) < 235
    cols = fg.sum(0) > 2
    W, H = len(cols), a.shape[0]
    runs, x = [], 0
    while x < W:
        if cols[x]:
            s = x
            while x < W and cols[x]:
                x += 1
            runs.append([s, x])
        x += 1
    merged: list[list[int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < 12:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    merged = [r for r in merged if r[1] - r[0] > 40]
    check: dict = {"segments": len(merged), "ok": False}
    if len(merged) != 3:
        return {"index": index, "sheet": path, "views": None, "check": check}
    widths, heights, views = [], [], {}
    for name, (s, e) in zip(VIEWS, merged):
        rows = np.nonzero(fg[:, s:e].sum(1) > 0)[0]
        widths.append(e - s)
        heights.append(int(rows.max() - rows.min()))
        pad = 60
        crop = im.crop((max(0, s - pad), 0, min(W, e + pad), H))
        side = max(crop.size)
        canvas = Image.new("RGB", (side, side), "white")
        canvas.paste(crop, ((side - crop.size[0]) // 2, (side - crop.size[1]) // 2))
        p = out_dir / f"sheet{index}_{name}.png"
        canvas.save(p)
        views[name] = str(p)
    wd = abs(widths[0] - widths[2]) / max(widths[0], widths[2])
    hd = (max(heights) - min(heights)) / max(heights)
    check.update({"widths": widths, "heights": heights, "widthDiff": round(wd, 4), "heightDiff": round(hd, 4),
                  "ok": bool(wd <= WIDTH_TOL and hd <= HEIGHT_TOL)})
    return {"index": index, "sheet": path, "views": views, "check": check}


def main() -> int:
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.loads(sys.stdin.read() or "{}")
        out_dir = Path(job["outDir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        sets = []
        for i, p in enumerate(job["sheets"]):
            sets.append(split(p, out_dir, i))
            emit("step", stage="split", i=i + 1, of=len(job["sheets"]))
        emit("done", sets=sets)
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        emit("error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())

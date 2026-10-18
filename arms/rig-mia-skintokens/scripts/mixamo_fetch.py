"""
Tải animation Mixamo (tên gốc, mô tả, ảnh động) về kho `<models>/rig/mixamo-lib/` — xem cliplib.py.

Mixamo bắt đăng nhập Adobe. Token do NGƯỜI DÙNG lấy (mixamo.com → F12 → Console → `localStorage.access_token`)
rồi ghi vào `E:/companion-web-cache/mixamo-token.txt` — ngoài repo, không in ra log. Token hết hạn (~1 ngày):
gặp 401 thì dừng, báo lấy lại; chạy lại sẽ bỏ qua clip đã có.

  python mixamo_fetch.py list               liệt kê mọi Motion → products.json (không tải FBX)
  python mixamo_fetch.py fetch [--limit N]  tải FBX + gif + meta cho clip chưa có (tuần tự, có nghỉ)
  python mixamo_fetch.py probe              gọi thử 1 trang + 1 chi tiết, in cấu trúc trả về

Xuất: FBX 7.x 2019, KHÔNG skin (chỉ khung của nhân vật chính trong tài khoản — Mixamo đặt tên xương
`mixamorig:*`), 30 fps, không giảm keyframe, bản thường (không in-place: trang tự khoá in-place).
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ai-studio: the studio's models directory; the token stays outside the repo, beside the arm's venv.
_HERE = Path(__file__).resolve().parent
LIB = Path(__import__("os").environ.get("AISTUDIO_MODELS_DIR") or _HERE.parents[2] / "storage" / "models") / "rig" / "mixamo-lib"
TOKEN_FILE = Path(__import__("os").environ.get("MIXAMO_TOKEN_FILE") or _HERE.parent / ".mixamo-token.txt")
API = "https://www.mixamo.com/api/v1"
PAUSE_S = 1.0


class AuthError(RuntimeError):
    pass


def token() -> str:
    if not TOKEN_FILE.is_file():
        raise AuthError(f"missing token file {TOKEN_FILE}")
    t = TOKEN_FILE.read_text(encoding="utf-8").strip().strip('"').strip("'")
    if not t:
        raise AuthError("empty token file")
    return t


def call(method: str, path: str, body: dict | None = None, raw_url: str | None = None) -> dict | bytes:
    url = raw_url or (API + path)
    headers = {"Accept": "application/json", "X-Api-Key": "mixamo2"}
    if not raw_url:
        headers["Authorization"] = "Bearer " + token()
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
                return b if raw_url else json.loads(b or b"{}")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise AuthError(f"HTTP {e.code} — token expired or invalid; get a new one") from None
            if e.code == 429 or e.code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} {method} {url.split('?')[0]}: {e.read()[:300]!r}") from None
        except urllib.error.URLError:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"giving up on {method} {url.split('?')[0]}")


def list_products() -> list[dict]:
    out, page, pages = [], 1, 1
    while page <= pages:
        r = call("GET", f"/products?page={page}&limit=96&order=&type=Motion&query=")
        out += r.get("results", [])
        pages = int((r.get("pagination") or {}).get("num_pages") or 1)
        print(json.dumps({"page": page, "pages": pages, "total": len(out)}), flush=True)
        page += 1
        time.sleep(PAUSE_S)
    LIB.mkdir(parents=True, exist_ok=True)
    (LIB / "products.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def primary_character() -> str:
    r = call("GET", "/characters/primary")
    cid = r.get("primary_character_id")
    if not cid:
        raise RuntimeError(f"no primary character: {r}")
    return cid


def export_one(p: dict, char_id: str) -> dict:
    pid = p["id"]
    det = call("GET", f"/products/{pid}?similar=0&character_id={char_id}")
    d = det.get("details") or {}
    g = dict(d.get("gms_hash") or {})
    if not g:
        raise RuntimeError("no gms_hash")
    g["params"] = ",".join(str(v[1]) for v in (g.get("params") or []))
    g["overdrive"] = 0
    call("POST", "/animations/export", {
        "character_id": char_id, "gms_hash": [g], "type": "Motion", "product_name": p.get("name") or pid,
        "preferences": {"format": "fbx7_2019", "skin": "false", "fps": "30", "reducekf": "0"}})
    t0 = time.time()
    while True:
        time.sleep(2)
        m = call("GET", f"/characters/{char_id}/monitor")
        st = m.get("status")
        if st == "completed":
            url = m.get("job_result")
            break
        if st == "failed" or time.time() - t0 > 180:
            raise RuntimeError(f"export {st or 'timeout'}: {str(m)[:200]}")
    (LIB / "fbx").mkdir(parents=True, exist_ok=True)
    (LIB / "fbx" / f"{pid}.fbx").write_bytes(call("GET", "", raw_url=url))
    thumb = p.get("thumbnail_animated") or p.get("thumbnail")
    if thumb:
        try:
            (LIB / "thumbs").mkdir(parents=True, exist_ok=True)
            (LIB / "thumbs" / f"{pid}.gif").write_bytes(call("GET", "", raw_url=thumb))
        except Exception:
            pass
    meta = {"id": pid, "name": p.get("name") or pid, "description": p.get("description") or "", "source": "mixamo",
            "category": p.get("category") or "", "motionId": p.get("motion_id"),
            "supportsInplace": bool(d.get("supports_inplace")), "loopable": d.get("loopable"),
            "extraTags": ["in-place"] if d.get("supports_inplace") else []}
    (LIB / "meta").mkdir(parents=True, exist_ok=True)
    (LIB / "meta" / f"{pid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def fetch(limit: int = 0) -> int:
    pf = LIB / "products.json"
    prods = json.loads(pf.read_text(encoding="utf-8")) if pf.is_file() else list_products()
    todo = [p for p in prods if not (LIB / "fbx" / f"{p['id']}.fbx").is_file()]
    if limit:
        todo = todo[:limit]
    char_id = primary_character()
    t0, ok, bad = time.time(), 0, []
    for i, p in enumerate(todo):
        try:
            export_one(p, char_id)
            ok += 1
        except AuthError as e:
            print(json.dumps({"stopped": str(e), "done": ok}), flush=True)
            return 3
        except Exception as e:
            bad.append({"id": p["id"], "name": p.get("name"), "error": str(e)[:300]})
        if (i + 1) % 10 == 0 or i + 1 == len(todo):
            print(json.dumps({"done": i + 1, "of": len(todo), "ok": ok, "bad": len(bad), "s": round(time.time() - t0)}), flush=True)
        time.sleep(PAUSE_S)
    if bad:
        (LIB / "fetch_errors.json").write_text(json.dumps(bad, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


def probe() -> int:
    r = call("GET", "/products?page=1&limit=2&order=&type=Motion&query=")
    print(json.dumps({k: v for k, v in r.items() if k != "results"}, ensure_ascii=False))
    p = r["results"][0]
    print(json.dumps(p, ensure_ascii=False)[:1500])
    cid = primary_character()
    print("primary character ok")
    det = call("GET", f"/products/{p['id']}?similar=0&character_id={cid}")
    print(json.dumps(det, ensure_ascii=False)[:2000])
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    cmd = a[0] if a else "probe"
    try:
        if cmd == "list":
            list_products()
            sys.exit(0)
        if cmd == "fetch":
            sys.exit(fetch(int(a[a.index("--limit") + 1]) if "--limit" in a else 0))
        if cmd == "probe":
            sys.exit(probe())
    except AuthError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(3)
    print(__doc__)
    sys.exit(2)

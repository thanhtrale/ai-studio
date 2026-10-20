"""
Kho clip cho trang review `/char3d/review`: FBX Mixamo → GLB CHỈ khung + một clip, rồi gộp `index.json`.

  <models>/rig/mixamo-lib/
    fbx/<id>.fbx       FBX tải về (mixamo_fetch.py) — chỉ khung, không skin
    meta/<id>.json     tên, mô tả, nguồn (mixamo_fetch.py); file này thêm frames/fps/durS/tags
    clips/<id>.glb     khung Mixamo + MỘT animation GỐC (arm-space làm ở trang, trên khung nhân vật)
    thumbs/<id>.gif    ảnh động Mixamo (nếu có)
    index.json         mọi meta gộp lại — server đọc file này

Trang ghép clip lên nhân vật ngay trong trình duyệt, theo tên xương `mixamorig:*`:
  xoay   q_nv(t) = nghỉ_nv · nghỉ_mixamo⁻¹ · q_clip(t)
  Hips   loc = nghỉ_mixamo⁻¹ · (T_clip(t) − T_nghỉ_mixamo);  T_nv = T_nghỉ_nv + nghỉ_nv · loc
Đã so với clip Blender tự gán trong `rigged.glb` (r108, Walk): xoay lệch ≤ 7e-7 ở 20/22 xương, Hips 8e-6 khi
khoá in-place (giữ loc[1], hai trục kia giữ giá trị khung đầu). (Đo lúc còn nướng armSpace 30 vào clip: hai cánh tay
lệch ~3° vì tính trên khung Mixamo — nên giờ clip để gốc, trang tự đẩy tay trên khung nhân vật.)

Chạy bằng Python có bpy (venv của arm mia-rig):
  python cliplib.py convert [--limit N] [--force]   FBX chưa có GLB → GLB (một tiến trình Blender cho cả lô)
  python cliplib.py index                           gộp meta/*.json → index.json (gắn lại tag)
  python cliplib.py seed-hf                         đưa 6 clip mặc định của dataset HF vào kho (để thử trang)
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# ai-studio: the studio's managed models directory, not companion-web's E:/ai-models.
MODELS = Path(__import__("os").environ.get("AISTUDIO_MODELS_DIR") or HERE.parents[2] / "storage" / "models")
LIB = MODELS / "rig" / "mixamo-lib"
# 0 = clip GỐC. Arm-space làm ở trang (Char3dAnimViewer), trên khung xương CỦA NHÂN VẬT như bước rig, chỉnh
# được độ — chibi đầu to cần đẩy nhiều hơn người thường. Nướng sẵn ở đây thì tính trên khung Mixamo, lệch ~3°.
ARM_SPACE = 0.0

# Bộ tag cố định — định danh, tiếng Anh. Mỗi tag: (nhóm, các mẫu regex khớp trên "tên + mô tả" viết thường).
TAGS: dict[str, tuple[str, list[str]]] = {
    # di chuyển. "Standing" KHÔNG phải idle: Mixamo đặt "Standing …" cho cả đi, chạy, bắn (305/612 tag idle nhầm vì nó)
    "idle": ("locomotion", [r"\bidle", r"\bbreathing\b", r"\bwaiting\b"]),
    "walk": ("locomotion", [r"\bwalk", r"\bstrut", r"\bsneak"]),
    "run": ("locomotion", [r"\brun", r"\bjog", r"\bsprint"]),
    "jump": ("locomotion", [r"\bjump", r"\bhop\b", r"\bleap", r"\bvault"]),
    "crouch": ("locomotion", [r"\bcrouch"]),
    "crawl": ("locomotion", [r"\bcrawl"]),
    "climb": ("locomotion", [r"\bclimb", r"\bladder", r"\bhang"]),
    "swim": ("locomotion", [r"\bswim", r"\btread", r"\bfloat"]),
    "fall": ("locomotion", [r"\bfall", r"\blanding\b", r"\bland\b"]),
    "turn": ("locomotion", [r"\bturn"]),
    "strafe": ("locomotion", [r"\bstrafe", r"\bside ?step"]),
    "roll": ("locomotion", [r"\broll", r"\bdodg", r"\bevad", r"flip\b", r"\bcartwheel", r"\bspin"]),
    "balance": ("locomotion", [r"\bteeter", r"\bwobbl", r"\bstumbl", r"\bbalanc", r"\btrip\b", r"\btripping"]),
    # chiến đấu
    "attack": ("combat", [r"\battack", r"\bslash", r"\bstab", r"\bswing", r"\bcombo", r"\bstrike", r"\bmelee", r"\bthrust",
                          r"\blunging", r"\bbite\b", r"\bstomp", r"\bslam", r"\bhostage", r"\bstrangl", r"\bheadbutt",
                          r"\bknee\b", r"\bassassinat"]),
    "punch": ("combat", [r"\bpunch", r"\bjab\b", r"\bhook\b", r"\buppercut", r"\bbox(ing|er)\b"]),  # "box" trơn: Jogging With Box
    "kick": ("combat", [r"\bkick", r"\bsweep\b"]),
    "block": ("combat", [r"\bblock", r"\bparry", r"\bguard"]),
    "hit": ("combat", [r"\bhit\b", r"\breact", r"\bimpact", r"\bknock", r"\bstun", r"\belectrocut", r"\bstrangled",
                       r"\bshoved", r"\bsmashed", r"\bagony", r"\bpain\b", r"\bconvuls", r"\bspat\b", r"\bgetting bit"]),
    "death": ("combat", [r"\bdeath", r"\bdying", r"\bdie\b", r"\bdead"]),
    "martial-arts": ("combat", [r"\bmartial", r"\bkarate", r"\bkung", r"\bcapoeira", r"\bmma\b", r"\bfight"]),
    "sword": ("weapon", [r"\bsword", r"\bkatana", r"\bblade"]),
    "shield": ("weapon", [r"\bshield"]),
    "axe": ("weapon", [r"\baxe"]),
    "gun": ("weapon", [r"\brifle", r"\bpistol", r"\bgun", r"\bammo", r"\bfiring", r"\bshoot", r"\breload", r"\baim"]),
    "bow": ("weapon", [r"\bbow ?(and|shot|draw|aim)", r"\barcher", r"\barrow", r"\bwith (a )?bow\b", r"\bequip\w* bow\b",
                       r"\boverdraw"]),
    "torch": ("weapon", [r"\btorch"]),
    "magic": ("combat", [r"\bmagic", r"\bspell", r"\bcast", r"\bwizard", r"\bsummon"]),
    "throw": ("combat", [r"\bthrow", r"\btoss", r"\bgrenade"]),
    # nhảy múa
    "dance": ("dance", [r"\bdanc", r"\bhip ?hop", r"\bsamba", r"\bsalsa", r"\btwerk", r"\bthriller", r"\bmacarena",
                        r"\btango", r"\bbreakdance", r"\bshuffl", r"\brumba", r"\bchicken", r"\bgangnam", r"\bwave dance",
                        r"\bcan can", r"\bhokey", r"\bbelly", r"\bbboy", r"\buprock", r"\bflair", r"\bwindmill", r"\bmoonwalk",
                        r"\brobot", r"\bjazz", r"\bballet", r"\bwaltz", r"\bcharleston"]),
    # biểu cảm, cử chỉ
    "wave": ("gesture", [r"\bwav(e|ing)\b(?!.*dance)"]),
    "gesture": ("gesture", [r"\bgestur", r"\bkiss", r"\bcount(ing)?\b", r"\bsigh", r"\brelie", r"\bsurpris", r"\bcocky",
                            r"\blisten", r"\bthumbs", r"\bpatting", r"\bshoulder rub", r"\bfocus\b", r"\bpray", r"\bterrif",
                            r"\bbashful", r"\breject", r"\broar", r"\brapping", r"\bplotting", r"\bshake fist", r"\bindicating",
                            r"\braising a hand", r"\bshaking hands"]),
    "talk": ("gesture", [r"\btalk", r"\bconversation", r"\bargu", r"\bexplain", r"\bphone"]),
    "cheer": ("gesture", [r"\bcheer", r"\bvictory", r"\bcelebrat", r"\bexcite", r"\bfist pump", r"\bhappy"]),
    "clap": ("gesture", [r"\bclap", r"\bapplau"]),
    "bow-gesture": ("gesture", [r"\bbow(ing)?\b", r"\bsalute", r"\bgreet"]),
    "point": ("gesture", [r"\bpoint"]),
    "laugh": ("gesture", [r"\blaugh"]),
    "sad": ("gesture", [r"\bsad\b", r"\bcry", r"\bdefeat", r"\bdisappoint", r"\bdepress"]),
    "angry": ("gesture", [r"\bangry", r"\brage", r"\bfrustrat", r"\byell", r"\bshout", r"\btaunt"]),
    "think": ("gesture", [r"\bthink", r"\bthought", r"\blook", r"\bsearch", r"\bpeek"]),
    "nod": ("gesture", [r"\bnod", r"\bagree", r"\bshak(e|ing) head", r"\bhead shake", r"\bshrug", r"\bdismiss"]),
    "pose": ("pose", [r"\bpose", r"\bposing", r"\blean"]),
    # tư thế nghỉ, tương tác
    "sit": ("rest", [r"\bsit", r"\bseated", r"\bchair"]),
    "lie": ("rest", [r"\blying", r"\blaying", r"\bsleep", r"\bprone", r"\bsupine"]),
    "kneel": ("rest", [r"\bkneel"]),
    "get-up": ("rest", [r"\bgetting up", r"\bget up", r"\bstand(ing)? up", r"\bkip up"]),
    "interact": ("interact", [r"\bpick", r"\bpush", r"\bpull", r"\bopen", r"\bcarry", r"\blift", r"\bdrink", r"\beat",
                              r"\btyp(e|ing)", r"\bbutton", r"\bdoor", r"\blever", r"\bgrab", r"\bplant", r"\bdriv",
                              r"\bmilk", r"\bwheelbarrow", r"\bharvest", r"\bswitch", r"\bcode\b", r"\bpetting", r"\bcards?\b",
                              r"\bdevice", r"\bgaming", r"\bvideo game", r"\bviolin", r"\bguitar", r"\bdrum", r"\bputting down",
                              r"\bequip", r"\bentering (car|into)", r"\bdice", r"\bmeeting", r"\bcpr\b", r"\bcar\b", r"\bpilot",
                              r"\bcooking", r"\bclean", r"\bdig", r"\bpaint", r"\bwriting", r"\breading\b", r"\bpaddl",
                              r"\bwatering", r"\bfax", r"\bfiling", r"\brummag", r"\bfinding", r"\breaching", r"\bhelping",
                              r"\bplaced", r"\bmoving object"]),
    "exercise": ("sports", [r"\bpush ?up", r"\bsit ?up", r"\bsquat", r"\bstretch", r"\bwarm", r"\bexercis", r"\bburpee",
                            r"\bplank", r"\bjumping jack", r"\byoga", r"\bworkout", r"\bcurl\b", r"\braises\b", r"\bsnatch",
                            r"\bdeadlift", r"\bcrunch"]),
    "sports": ("sports", [r"\bsoccer", r"\bfootball", r"\bbasketball", r"\bbaseball", r"\bgolf", r"\btennis", r"\bskat",
                          r"\bgoalkeeper", r"\bpitch", r"\bbat\b", r"\bdribbl", r"\bvolley", r"\bquarterback", r"\bwrestl",
                          r"\bring\b", r"\breferee", r"\bhell slammer", r"\bdunk", r"\blayup"]),
    # kiểu nhân vật
    "zombie": ("style", [r"\bzombie", r"\bmutant", r"\bmonster", r"\bcreature", r"\bvampir"]),
    "injured": ("style", [r"\binjur", r"\bwound", r"\blimp", r"\bdrunk"]),
    "female": ("style", [r"\bfemale", r"\bwoman", r"\bgirl", r"\bsexy"]),
}
TAG_GROUPS = ["locomotion", "combat", "weapon", "dance", "gesture", "pose", "rest", "interact", "sports", "style", "length"]

# Khớp mẫu nhưng ngữ cảnh nói khác → BÁC tag (luật loại chỉ bác, không thêm). Đo trên 2446 tên Mixamo:
# "With Bow"/"Aim" của cung bị gắn bow-gesture và gun; "shoot" của bóng rổ bị gắn gun.
EXCLUDE: dict[str, list[str]] = {
    "bow-gesture": [r"\barrow", r"\bwith (a )?bow\b", r"\bbow (and|shot|draw|aim|idle|walk|run)", r"\baim", r"\bequip\w* bow",
                    r"\b(holding|disarm\w*|examin\w*) bow",
                    r"\boverdraw", r"\bbow\b.*\b(walk|run|turn|jump|death|dodge|strafe|reload)"],
    "gun": [r"\barrow", r"\bwith (a )?bow\b", r"\bbow\b", r"\bbasketball", r"\bsoccer", r"\bfootball", r"\bhockey", r"\bgolf"],
    "walk": [r"\bwalk(ing)? (the )?(dog|plank)"],
}


def tag_text(text: str) -> list[str]:
    t = text.lower()
    out = []
    for k, (_, pats) in TAGS.items():
        if any(re.search(p, t) for p in pats) and not any(re.search(x, t) for x in EXCLUDE.get(k, [])):
            out.append(k)
    return out


# ai-studio: one primary CATEGORY per clip for the gallery's category filter -- the most specific group
# among its tags (a sword combo is "weapon" before "combat", a dance step "dance" before "locomotion").
CATEGORY_ORDER = ["weapon", "combat", "dance", "sports", "interact", "gesture", "locomotion", "pose", "rest", "style"]


def category_of(tags: list[str]) -> str:
    groups = {TAGS[t][0] for t in tags if t in TAGS}
    if "in-place" in tags:
        groups.add("locomotion")
    return next((g for g in CATEGORY_ORDER if g in groups), "other")


def length_tag(dur: float | None) -> list[str]:
    if dur is None:
        return []
    return ["short"] if dur < 1.5 else (["long"] if dur > 8 else [])


def convert(limit: int = 0, force: bool = False) -> int:
    import bpy

    sys.path.insert(0, str(HERE))
    import rig as RG  # arm_space — cùng hàm bước rig dùng

    todo = []
    for f in sorted((LIB / "fbx").glob("*.fbx")):
        mp = LIB / "meta" / (f.stem + ".json")
        # meta thiếu `frames`: mixamo_fetch ghi meta SAU fbx — lần chuyển chạy chen giữa thì meta bị ghi đè mất số khung
        no_frames = mp.is_file() and "frames" not in json.loads(mp.read_text(encoding="utf-8"))
        if force or no_frames or not (LIB / "clips" / (f.stem + ".glb")).is_file():
            todo.append(f)
    if limit:
        todo = todo[:limit]
    (LIB / "clips").mkdir(parents=True, exist_ok=True)
    t0, ok, bad = time.time(), 0, []
    for i, f in enumerate(todo):
        try:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.fbx(filepath=str(f))
            arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
            if not arms or arms[0].animation_data is None or arms[0].animation_data.action is None:
                raise RuntimeError("no armature/action")
            arm = arms[0]
            for o in list(bpy.context.scene.objects):
                if o is not arm:
                    bpy.data.objects.remove(o, do_unlink=True)
            act = arm.animation_data.action
            f0, f1 = (int(round(v)) for v in act.frame_range)
            stats = RG.arm_space(arm, act, ARM_SPACE) if ARM_SPACE else None
            arm.animation_data.action = act
            act.name = f.stem
            out = LIB / "clips" / (f.stem + ".glb")
            bpy.ops.export_scene.gltf(filepath=str(out), export_animations=True, export_animation_mode="ACTIVE_ACTIONS",
                                      export_rest_position_armature=True, export_draco_mesh_compression_enable=False)
            fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
            mp = LIB / "meta" / (f.stem + ".json")
            meta = json.loads(mp.read_text(encoding="utf-8")) if mp.is_file() else {"id": f.stem, "name": f.stem}
            meta.update(frames=f1 - f0 + 1, fps=round(fps, 3), durS=round((f1 - f0) / fps, 2),
                        armSpace=ARM_SPACE, armSpaceMaxDeg=stats and stats.get("maxDeg"), clipBytes=out.stat().st_size)
            mp.parent.mkdir(parents=True, exist_ok=True)
            mp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            ok += 1
        except Exception as e:  # một clip hỏng không dừng cả lô
            bad.append({"id": f.stem, "error": f"{type(e).__name__}: {e}"})
        if (i + 1) % 25 == 0 or i + 1 == len(todo):
            print(json.dumps({"done": i + 1, "of": len(todo), "ok": ok, "bad": len(bad), "s": round(time.time() - t0)}), flush=True)
    if bad:
        (LIB / "convert_errors.json").write_text(json.dumps(bad, indent=1), encoding="utf-8")
    return 0


def index() -> int:
    rows = []
    for mp in sorted((LIB / "meta").glob("*.json")):
        m = json.loads(mp.read_text(encoding="utf-8"))
        if not (LIB / "clips" / (mp.stem + ".glb")).is_file():
            continue
        text = " ".join(str(m.get(k) or "") for k in ("name", "description"))
        tags = tag_text(text) + length_tag(m.get("durS")) + list(m.get("extraTags") or [])
        m["tags"] = sorted(set(tags))
        m["category"] = category_of(m["tags"])
        m["thumb"] = (LIB / "thumbs" / (mp.stem + ".gif")).is_file()
        rows.append(m)
    groups = {k: g for k, (g, _) in TAGS.items()}
    groups.update(short="length", long="length", **{"in-place": "locomotion", "hf-dataset": "source"})
    (LIB / "index.json").write_text(json.dumps({"builtAt": int(time.time() * 1000), "tagGroups": groups, "groupOrder": TAG_GROUPS + ["source"],
                                                "clips": rows}, ensure_ascii=False), encoding="utf-8")
    untagged = sum(1 for r in rows if not [t for t in r["tags"] if t not in ("short", "long")])
    categories: dict[str, int] = {}
    for r in rows:
        categories[r["category"]] = categories.get(r["category"], 0) + 1
    print(json.dumps({"clips": len(rows), "untagged": untagged, "categories": categories}))
    return 0


def seed_hf() -> int:
    """6 clip mặc định của bước rig (dataset HF `jasongzy/Mixamo`, tên hash) — chỉ để thử trang khi chưa tải Mixamo."""
    import shutil

    names = {"Idle": "animation/3096cfbfdee2ae25839f87f2a1bbb990", "Walk": "animation/b43f0d184adbb90490e4b2bd8544d06a",
             "Run": "extra/Standard Run", "Jump": "animation/974f88fd4f199ad531617c10db365d73",
             "Wave": "animation/155309ffdd8ff5956a48f64278e5bde8", "Dance": "animation/9696aafe2b85750100df067600778d1b"}
    for d in ("fbx", "meta"):
        (LIB / d).mkdir(parents=True, exist_ok=True)
    for name, rel in names.items():
        cid = "hf-" + name.lower()
        shutil.copyfile(MODELS / "rig" / "mixamo" / (rel + ".fbx"), LIB / "fbx" / (cid + ".fbx"))
        (LIB / "meta" / (cid + ".json")).write_text(json.dumps(
            {"id": cid, "name": name, "description": f"Default rig clip ({rel})", "source": "hf-dataset",
             "extraTags": ["hf-dataset"]}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    if cmd == "convert":
        a = sys.argv[2:]
        lim = int(a[a.index("--limit") + 1]) if "--limit" in a else 0
        sys.exit(convert(lim, "--force" in a))
    if cmd == "index":
        sys.exit(index())
    if cmd == "seed-hf":
        sys.exit(seed_hf())
    print(__doc__)
    sys.exit(2)

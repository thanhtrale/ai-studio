> **Verbatim from companion-web** (`docs/log/char3d.md` at commit 5afbdcb, 2026-10-18), where this pipeline was built and measured. Kept in its original Vietnamese and never edited: it is the evidence behind [../char3d.md](../char3d.md). Arm names here are companion-web's: `qwen-image-21-turbo-comfyui` → `image-qwen21-turbo-official-comfy`, `pixal3d-comfyui` → `mesh-pixal3d-comfy`, `mia-rig` → `rig-mia-skintokens` (+ `mesh-char3d-tools`), `hy3dshape`/`hy3dpaint` → `mesh-hunyuan3d-paint`. Paths like `E:/ai-models` and `.data/char3d` are companion-web's.

# Nhật ký — nhân vật 3D (`/char3d`)

Chỉ thêm, không sửa. Kết luận rút ra nằm ở [../char3d.md](../char3d.md).

Máy: RTX 5070 12 GB (Blackwell, sm_120), 32 GB RAM, Windows 11. ComfyUI dùng chung `E:\comfy\ComfyUI`
commit 8d53494 (0.37.0, torch 2.13 cu130). Mọi lượt chạy qua hàng đợi server 3000 (`feature: char3d`).

## 2026-10-16 — nhân vật `cau-be-vo-sinh` (chibi, ảnh ref người dùng đưa)

Ảnh ref: chibi nam, tóc đuôi ngựa, áo giao lĩnh trắng viền xanh xám, đai, quần ống túm, xà cạp.
Ảnh gốc ĐÃ là A-pose nhìn thẳng, nền trắng.

### r01-ref — lỗi hạ tầng

`runArm` đổi ô `references` từ TÊN FILE trong `.data/reference` sang đường tuyệt đối và chặn mọi
đường dẫn → `ảnh phải là TÊN FILE trong .data/reference`. Runner sửa bằng cách đưa arm bản
manifest không có ô reference (đường do server dựng, đã qua `charFile`).

### r02-ref — Qwen-Image-2.1 Turbo, prompt v1, 4 góc × 2 seed, 896×1152

| | |
|---|---|
| thời gian | 78,6 s cả lượt; mỗi góc ~19 s (ảnh đầu 12,3 s gồm ~5 s encode ref, ảnh sau 6,4 s) |
| đỉnh VRAM máy | 11 369–11 560 MiB |

Chấm bằng mắt từng ảnh:

| ảnh | góc đúng | ghi chú |
|---|---|---|
| front_0, front_1 | ✓ | gần như chép ref (ref vốn A-pose) |
| left_0 | **✗** | nhìn sang PHẢI ảnh — ngược prompt |
| left_1 | ✓ | profile trái, nhìn sang trái ảnh |
| back_0, back_1 | ✓ | back_1 sạch hơn, nút đai đúng bên trái |
| right_0 | ✓ | profile thẳng |
| right_1 | ~ | chéo 3/4 |

Búi tóc đổi dáng giữa các góc. Nền #f8f8f8, không bóng. Chọn front_0, left_1, back_1, right_0.

### Mesh — Pixal3D int8 convrot, template mặc định (structure 12 / shape 20 / refine 12 / texture 12 bước, upsample 1536, remesh 768, 300k mặt)

Ảnh chụp kiểm tra: Workbench, ortho, 8 góc texture + 4 góc clay + cận mặt.

| lượt | ảnh vào | seed | atlas | thời gian mesh | đỉnh VRAM | mặt | lưng | tóc |
|---|---|---|---|---:|---:|---|---|---|
| r03 | front | 42 | 2048 | 93,2 s | 11 164 | **9** — sắc, cười, má hồng | **4** — bịa hình in logo trên lưng áo | 7, khối sau đầu phồng |
| r04 | front+left+back+right | 42 | 2048 | 126,5 s | 10 027 | 5 — mắt nhoè, mất miệng | 9 | 8 |
| r05 | front+back | 42 | 2048 | 119,2 s | 11 032 | 7 | 9 | 6 — **nâu** |
| r06 | front+back | 7 | 2048 | ~120 s | — | 8 | 9 | 8 — đen |
| r07 | front+back | 1234 | 2048 | ~120 s | — | 4 — mặt cau | 8 | 8 |

Phân rã r03 (một ảnh, ms): Pixal3DConditioning 8 311 · structure 3 731 · shape 2 798 · refine 17 381 ·
texture 9 422 · decode shape 1 911 · decode texture 2 099 · remesh 2 572 · decimate 2 410 · unwrap 6 970 ·
bake color 7 866 · bake normal 4 039 · **bake AO 16 538** · SaveGLB 1 125.
r04 (4 góc): Pixal3DMultiViewConditioning **29 798** (NAF upsample cho 4 ảnh), refine 22 909, texture 12 694.

Đọc:
- Bốn góc làm mặt nhoè: ảnh profile do Qwen vẽ không khớp tuyệt đối ảnh front, giàn camera chiếu
  chúng lên cùng vùng đầu → trộn. Bỏ hai profile (r05) mặt sắc lại.
- Một ảnh thì model ĐOÁN lưng và đoán sai kiểu "thêm chi tiết" (logo).
- r05/r06/r07 cùng cấu hình khác seed: màu tóc (nâu/đen/đen) và biểu cảm (ổn/ổn/cau) đổi theo seed.
  Một seed là một điểm.

### Hạ tầng đã cắn trong ngày

- Tailwind của dev server KHÔNG quét file `.vue` mới tạo: lớp chỉ có trong trang mới (`h-20`, `size-24`,
  `min-w-80`) không được sinh, trang vỡ bố cục. Chạm `app/assets/css/tailwind.css` (mtime) là quét lại.
- Ảnh cận mặt lần đầu lấy tâm 17% từ đỉnh bbox → chỉ thấy tóc (chibi đầu ~45% thân, búi tóc là đỉnh).
  Đổi 36%. Ánh sáng Studio của Workbench làm áo trắng thành xám → đổi FLAT cho ảnh texture.
- Python trên Windows ghi file text bằng CRLF — sửa file TS bằng script Python phải `newline='\n'`.
- `—` gõ thẳng trong `curl -d` của Git Bash thành `�` trong JSON. Gửi `--data-binary @file`.

### r08–r11 — một biến mỗi lượt, gốc là cấu hình r06 (front_0 + back_1, seed 7)

| lượt | đổi | thời gian mesh | kết quả |
|---|---|---:|---|
| r08 | atlas 2048 → 4096 | 114,3 s | ảnh cận 768px **giống hệt** r06; GLB to hơn |
| r09 | fov 20 → 10 | ~120 s | mặt nhạt, mềm; tóc ngả nâu — kém |
| r10 | fov 20 → 35 | ~120 s | mặt cau, mảng tối ở tai — kém |
| r11 | textureSteps 12 → 24 | ~130 s | mặt như r06; **bịa vệt trắng** trên dải cổ áo — kém |

Giả thuyết "ảnh Qwen gần ortho nên fov nhỏ khớp hơn" sai: fov 20 mặc định của giàn tốt nhất ở cả hai phía.
Độ mềm của mặt không đến từ atlas (r08) hay số bước texture (r11).

Chốt mesh để rig: **r06** (83/100). Bước rig chờ: dataset `jasongzy/Mixamo` (chứa `bones.fbx`) trả 403
"not in the authorized list" với token của máy — người dùng cần bấm Agree.

## 2026-10-16 (chiều) — bước rig, Make-It-Animatable v2, mesh r06

Người dùng Agree dataset `jasongzy/Mixamo`. Mọi lượt: mesh `runs/r06-mesh/mesh.glb` (212 773 đỉnh,
299 048 mặt), Ô `oneshot`, đỉnh VRAM 4,7–8,8 GB.

### Hạ tầng (r12–r14, đều chết trước khi có kết quả)

| lượt | lỗi | sửa |
|---|---|---|
| r12 | `DLL load failed while importing bpy` | `trimesh[easy]` nạp trước bpy là hỏng (torch→bpy thì ổn). `import bpy` dòng đầu `rig.py` |
| r13 | transformers 4.46 đòi `huggingface_hub<1.0`, gradio kéo lên 2.2 | ghim hub 0.36.2, gradio 5.50 |
| r14 | `PermissionError` trên file tạm | MIA mở lại `NamedTemporaryFile` (chỉ Linux được) → thay bằng mkstemp |

### Từng tầng lỗi trên chibi — mỗi tầng chỉ lộ ra khi tầng trên đã sửa

| lượt | đổi | quan sát | stretch* p99 · max · >2× |
|---|---|---|---|
| r15 | MIA mặc định, A-pose | rest.glb và cả `rest_lbs.glb` do MIA tự tính: tay kéo dài hình chữ V | — |
| r16 | bỏ pose dự đoán | CẢ THÂN nghiêng ~30°; khớp rác (Neck x −0,28, hai bàn chân cùng phía) | — |
| r17 | `canonical` (bỏ xoay khung hông) | đứng thẳng, chạy ra dáng; cổ/vai nằm TRONG đầu (LeftArm y 0,569, Neck 0,596; vai thật ~0) | 2,70 · 101 · 2,3% |
| r18 | + luật chuỗi trọng số | không đỡ | 3,49 · 99 · 3,0% |
| r19 | + co đầu (cổ ở 61% cao, đầu 39% → ×0,385) | khung đúng chỗ; bàn tay TRÁI xoè quạt | 2,15 · 126 · 1,2% |
| r20 | + luật khoảng cách (near 0,04·H, far 0,1·H) | T-pose sạch, chạy sạch | 2,10 · 59 · 1,1% |
| r21 | 12 clip từ catalog | xem mục clip dưới | 1,28–2,36 (p99) |
| r22 | 6 clip chốt | ngón trái nhàu; mảng đen trong model-viewer | 1,37–2,05 |
| r23 | `noFingers` | hết nhàu, 2 mũi nhọn kéo xuống (đầu ngón chạm quần → gán theo chân) | 1,33–1,99 |
| r24 | + lọc đảo trên đồ thị đỉnh | tay liền; mảng đen còn | 1,32–2,00 |
| r25 | + lật 1860 mặt theo NORMAL gốc, mang NORMAL sang Blender | ngực bớt đen, tay áo vẫn đen (cả rest.glb) | — |
| r27 | + bỏ `occlusionTexture` | **hết mảng đen** | như r24 |

*stretch = tỉ lệ dài cạnh khung/tư thế nghỉ, khung xấu nhất của Standard Run (r15–r20) hoặc dải p99 qua các
clip; bỏ cạnh < ½ trung vị. Hai bản đầu của thước (chưa lọc cạnh ngắn) ra max ~240 vì cạnh gần 0 sau remesh.

Mảng đen: r06 trong model-viewer sạch; rest.glb (tĩnh) đen ở tay áo → đúng vùng biến dạng A→T. Đã loại:
metallic (kênh B của ORM = 0 ở cả hai), UV gộp (trimesh giữ đủ 212 773 đỉnh), pháp tuyến (r25 chỉ bớt một
phần), vỏ trong UDF (r26: `drop_inverted_components` 53,3% → 49,6% đỉnh có lớp ngược sát bên — gần như
không đổi). Còn lại: AO bake tĩnh = 0 ở lòng tay áo; Workbench không dùng AO nên ảnh kiểm tra không thấy.

Phân rã r27 (ms): import 6 876 · nạp model 9 193 · khớp thô 4 193 · infer 1 594 · post 5 595 · weight-fix
1 967 · bind Blender 20 124 · gắn 6 clip 995 · xuất GLB+FBX 13 073. GLB 55 MiB, FBX 21 MiB.

### Clip

Dataset: 2453 FBX tên hash, FBX không mang tên gốc. `catalog.py` (bpy, CPU, 275 s cho cả bộ): 1817 clip khác
nhau sau khi khử trùng đặc trưng; nhãn idle 417 · run 337 · low 285 · walk 272 · jump 226 · dance 125 · wave 72.
r21 xem 2 ứng viên mỗi nhãn trên nhân vật: walk/idle/dance-1/jump-1 tốt; "run" bắt nhầm kiểu chạy khom; dance-2
ngã; jump-2 kết thúc ngồi xổm. Clip giơ tay cao: tay chibi ngắn chạm/xuyên mặt.

### Bàn tay lỗi, nách giãn khi giơ tay (r28–r37, 2026-10-16)

Người dùng báo trên r27. Thước mới: `stretch` theo VÙNG (đỉnh bị kéo > 2,5× ở bất kỳ khung nào của 6 clip,
gom theo xương trội) + phép thử LBS numpy trên `mia_pred.npz` (A→T, giơ thêm 70°, gập cổ tay 60°).

Chẩn đoán r27:
- Bàn tay TRÁI: trọng số chuyển sang Hand ở GIỮA lòng bàn tay (tại khớp Hand chỉ 13–20% Hand; tay phải
  55–93%); đầu ngón còn 16–23% ForeArm → gập cổ tay là bàn tay gãy, đầu ngón kéo sợi.
- Nách: 963 đỉnh giãn > 2× đã ở A→T, nằm gọn 40–60% chiều cao: mặt trong tay áo HÀN vào sườn, mép dưới tay
  áo hàn vào đai/hông (remesh UDF). Trọng số ở đó lổn nhổn vai/tay/Spine/UpLeg.

Thử numpy (cùng một dự đoán, r27):

| | A→T max · >3× | giơ 70° max · >3× | gập cổ tay: cạnh > 2× thêm so với A→T |
|---|---|---|---|
| r27 | 63 · 534 | 114 · 907 | +314 |
| + bàn tay một khối | 63 · 534 | 114 · 907 | +18 |
| + mượt nách (vùng tay–thân, 60 vòng) | 35 · 69 | 63 · 162 | — |
| + mượt nách (vùng tay–MỌI THỨ, 150 vòng, 10 vòng nới) | 3,1 · 1 | 4,6 · 16 | +18 |

**MIA không tất định**: r27 vs r28 (cùng cấu hình) lớp `distance` chuyển 1448 vs 8268 đỉnh; đặt `fix_random`
trước lấy mẫu vẫn lệch (r29 vs r30: 4017 vs 1129) — nhiễu GPU. So hai lượt rig khác dự đoán là so nhiễu
(r28 có vá mà tệ hơn r27 không vá). → `mia_raw.pkl` (dự đoán thô, 175 MB) + `predFrom`.

Cùng dự đoán (r31 tắt vá / r33 bật vá):

| | đỉnh giãn > 2,5× (6 clip) | bàn tay trái · phải | Spine2 · vai+cánh tay trái | >2× Wave |
|---|---|---|---|---|
| r31 | 8552 | 609 · 130 | 761 · 597 | 0,44% |
| r33 | 6144 | 60 · 0 | 287 · 217 | 0,20% |

Bằng mắt (Wave, cận nách): r31 một MÀNG căng từ cánh tay giơ xuống eo; r33 hết màng nhưng nách NHÀU, các lớp
hàn chồng lên nhau. Mượt chỉ đổi kiểu lỗi — vùng hàn không có hình học dưới nách. Còn lại không đổi: đường
đũng quần (Jump/Run, max ~100 — chân, ngoài phạm vi).

T-pose (r34 ref → r35 mesh → r36/r37 rig, `restPose: "T-pose"`): mesh đẹp, tay áo tách khỏi thân. Nhưng MIA đặt
khớp SAI: khuỷu x 0,33, cổ tay 0,38–0,42, trong khi tay áo hết ở 0,45, cẳng tay lộ 0,46–0,61, cổ tay thật ~0,60,
đầu ngón 0,83. Nửa trên tay áo theo Shoulder → hạ tay là tay áo đứng lại ngang vai như CÁNH (r37 không vá
cũng có, r36 có vá nặng hơn: Shoulder trội ở tay áo phải 217 → 641 đỉnh). p999 9–44 (A-pose: 2,4–5).
Tóc r35 ra nâu sẫm (seed 7 với ảnh mới).

A-pose rộng ~50° (r38 ref → r39 mesh, seed 7): tay áo hở khỏi sườn. Rig bằng trọng số MIA + vá (r40): VẪN xé
tay áo thành sợi khi giơ, Idle có cánh nhỏ — mesh đã tách mà trọng số MIA vẫn hỏng.

**Bone heat** (Blender ARMATURE_AUTO, khớp của MIA): trên mesh Pixal3D thẳng → "failed to find solution",
trả rỗng. Giữ mảnh liền lớn nhất của proxy voxel vẫn hỏng; phóng ×100 → chạy (1 s). Thử numpy, cùng dự đoán r40:

| | A→T max · >3× | giơ 70° max · >3× | hạ tay sát người max · >3× |
|---|---|---|---|
| MIA + vá | 90 · 152 | 121 · 510 | 47 · 371 |
| bone heat | 3,5 · 9 | 7,8 · 123 | 5,7 · 15 |

Qua Blender, 6 clip (cùng dự đoán, `predFrom`):

| | max | p999 | >2× (‰) |
|---|---|---|---|
| r40 MIA + vá | 21–84 | 3,5–9,4 | 2,8–8,9 |
| r41 bone heat | 10–21 | 2,6–4,1 | 2,6–6,9 |
| r42 bone heat trên mesh r06 (hàn) | 12–54 | 3,1–5,2 | 2,7–10,4 |
| r33 MIA + vá trên mesh r06 | 25–105 | 2,4–5,1 | 1,4–7,5 |

r41 bằng mắt: Wave tay áo đi theo tay như vải, nách mượt; Idle hết cánh; bàn tay sạch mọi clip; Run/Jump/Dance
sạch, vạt áo lộ vài đốm xám. Mesh hàn (r06) thì bone heat không cứu.

Màu tóc theo seed mesh (cùng ảnh r38): 7 nâu sẫm · 42 gần đen nhưng bake vạch ĐEN lên cẳng tay · 1234 đen,
da xám · 5 nâu · 11 gần đen, tai chìa. Rig phụ thuộc MESH: r43 (seed 42) rig 3 lượt đều p999 4–10 (vạt áo xé
răng cưa khi chạy); r49 (seed 11) p999 6–26. Chốt **r41** (mesh r39), tóc nâu sẫm là điểm trừ còn lại.

### Dọn mesh + SkinTokens (r51–r61)

Đo mesh Pixal3D (r06/r39/r43/r49): 61–68% đỉnh có mặt quay ngược trong 0,4% chiều cao (vỏ hai lớp của remesh
UDF), 1618–2484 cạnh non-manifold, không kín, 3–22 mảnh. MIA nhận điểm + PHÁP TUYẾN → lẫn trong/ngoài.

`prep` (voxel 0,003·H → mảnh lớn nhất → decimate 60k; trọng số chép về mesh gốc). Bake lại texture lên vỏ
prep (Cycles selected→active) ra lốm đốm (trúng lớp trong/lọn tóc) → bỏ, giữ texture gốc.

p999 theo clip (Dance, Idle, Jump, Run, Walk, Wave):

| mesh | bone heat, không prep | heat + prep (voxel proxy) | heat + prep (thẳng trên vỏ) | SkinTokens + prep |
|---|---|---|---|---|
| r39 | r41: 2,6–4,1 | r51/r52: 2,3–3,1 / 2,1–3,5 | r55: 2,8–4,4 | r59: 2,0–3,8 |
| r43 | r45–r47: 4–10 | r53: 9–41 (proxy vỡ 569 mảnh) | r56: 4,0–5,8 | r60: 1,8–3,9 |
| r49 | r50: 6–26 | r54: 3,6–7,4 | r57: 3,3–5,4 | r61: 1,6–3,0 |

(cột 3–5 cùng một dự đoán MIA mỗi mesh qua `predFrom`.) SkinTokens: đỉnh VRAM 3,8 GB với SDPA, 53 s. Nhìn:
r59 nách tốt hơn r52 một chút, đuôi đai vỡ vài mảnh khi chạy (r52 không); r61 sạch nách/hông/tay, tóc đen.
Chốt r61 (ref r38, mesh r49 seed 11).

### Arm-space + SkinTokens không tất định (r62–r63)

Người dùng: tay ép vào thân; Mixamo có thanh "Character Arm-Space". `arm_space` (rig.py): mỗi khung xoay cánh
tay về phía ngang (hướng tay ở T-pose) một góc `armSpace`·|hướng tay · trục dọc|. Thước chạm: % đỉnh trội
ForeArm/Hand cách đỉnh trội thân (Hips/Spine*/UpLeg) < 1% chiều cao, 24 khung/clip, trên rigged.glb r61
(cùng trọng số), trung bình theo khung (max trong ngoặc):

| clip | 0° | 15° | 30° |
|---|---|---|---|
| Idle | 39 (59) | 25 (36) | 11 (21) |
| Walk | 45 (53) | 27 (61) | 19 (64) |
| Jump | 33 (54) | 17 (40) | 9 (34) |
| Run | 11 (24) | 6 (16) | 3 (14) |
| Wave | 21 (46) | 7 (39) | 0,6 (6) |
| Dance | 13 (30) | 4 (31) | 2,5 (30) |

Chạm đầu (cẳng tay/bàn tay ↔ Head/Neck) Dance 6,8 → 4,0. Walk max còn cao: tay đánh trước/sau quệt đai buông.
Độ giãn không đổi (p999 cùng trọng số: 0° 1,8–2,8; 30° 1,75–2,8).

r62 (armSpace 30, chạy lại SkinTokens cùng predFrom, cùng ST_SEED): p999 lên 3,0–4,05, giãn ở CHÂN/HÔNG —
chỗ arm-space không đụng. Nguyên nhân: TokenRig lấy mẫu top-k không tất định trên GPU; r61 vs r62 16% đỉnh lệch
> 0,1, 3,9% đổi xương trội. → cờ `skinFrom` (dùng lại st_out.npz). r63 = trọng số r61 + armSpace 30: p999
1,7–3,0, max 5,7–9,2 (r61 1,8–3,0 / 6,7–9,0). Chốt r63.

Texture (người dùng báo: tai lem lên tóc, vệt đen dưới cằm, da sát mép tay áo): chụp cận mesh r49 GỐC (chưa
rig) thấy đủ ba lỗi → của bước mesh, không của rig. Đều là vùng ảnh front/back không thấy: hai bên đầu, mặt
dưới cằm, lòng tay áo, cạnh cẳng tay.

### Hunyuan3D-Paint 2.1 tô lại texture (r64–r66)

Arm `arms/hy3dpaint` (repo @82920d6, venv riêng Python 3.11 + bpy 4.3). Build trên Windows: `custom_rasterizer`
(MSVC 2022 + CUDA 12.8, sm_120) phải vá `grid_neighbor.cpp` — ép `(int64_t)` trong `torch::zeros({...})` và
`long` → `int64_t` (Windows `long` 32 bit: thiếu symbol `data_ptr<long>`, và `(long)maxint` cắt cụt);
`mesh_inpaint_processor` build tay bằng `cl`. `setuptools<81` (lightning_fabric cần pkg_resources), shim
`torchvision.transforms.functional_tensor` cho basicsr.

r64: reserveMiB 11000 bị từ chối (desktop giữ ~2 GB) → hàng TỰ DỪNG, phải `POST /api/jobs/queue {"action":"resume"}`.
r66 (mesh r49 nguyên hình khối, ảnh r38 front_0, 6 góc @512), từng giai đoạn: load 13 s / đỉnh 6,8 GB ·
xatlas UV 300k mặt 312 s · render pháp tuyến 1,5 s · **multiview 224 s, đỉnh 13,7 GB > 12,2 GB card = tràn
sang RAM** · RealESRGAN 6 s · bake 2 s · inpaint 32 s. Tổng ~10 phút.

Kết quả bằng mắt so với r49 (Pixal3D): hết vệt tối dưới cằm; nhưng TỆ HƠN ở chỗ khác — mảng cam lem quanh tai và
chân tóc (ảnh góc dưới lên −90° sinh rác đỏ), mặt mờ (512 px cho cả người → mặt ~60 px), màu lệch ref
(navy → xanh lam, trắng → xám). Ảnh 6 góc tự nó nhất quán, lỗi là ĐỘ PHÂN GIẢI mỗi góc với chibi toàn thân.
Không dùng. 768 px cần thêm VRAM, không vừa card.

### Hunyuan3D-2.1 Shape + chiếu ảnh ref (r67–r78)

Arm `arms/hy3dshape` (chung venv/repo với `hy3dpaint`; thêm `timm`). Chỉ ảnh FRONT (ghép front+back làm người
nhỏ trong ảnh → mặt mất chi tiết — người dùng). Tách nền trắng bằng flood fill từ mép (áo trắng không bị khoét).
Giai đoạn: nạp 17–27 s / 7,0 GB · khuếch tán 50 bước 46–52 s / đỉnh 7,8 GB · đẩy DiT ra CPU · giải mã 384³
(FlashVDM) 3–8 s / 4,1 GB · dọn mảnh + giảm 200k mặt 5 s. ~1,5 phút, card đỉnh ~9,1 GB — KHÔNG tràn.

| seed | lượt | kín | mảnh | nhận xét |
|---|---|---|---|---|
| 0 | r70 | có | 1 | sạch; bím sau lưng to hơn ref |
| 7 | r71 | không | 5 | sợi rác nối tóc với tay |
| 11 | r72 | có | 1 | sạch nhất |

Rig cấu hình r63 (không predFrom): r73 (mesh r70) p999 1,7–2,9 / max 4,5–8,7; **r74 (mesh r72) p999 1,7–2,7 /
max 3,7–6,2** (r63 trên Pixal3D: 1,7–3,0 / 5,7–9,2). Clay Wave/Run/Dance sạch. Vỏ kín một lớp rig tốt hơn.

Texture — chế độ `mode: "project"` của arm `hy3dpaint` (không khuếch tán, đỉnh 2,7–4 GB, ~1 phút):
- r75: chiếu front_0 (0°) + back_1 (180°), khớp khung bao. Front IoU bóng 0,79, back 0,67 (tay trong ảnh back dang
  ngang hơn). MẶT NÉT NHẤT từ trước. Nhưng chỉ 20% UV được chiếu (góc ≤ 60°); `uv_inpaint` của repo lấp theo UV →
  xám, lốm đốm.
- r76: lỗi mặt nạ `uv_feature_map(bg=)` (chỉ đúng 1 kênh).
- r77: lấp theo 3D (k=8 texel đã có màu gần nhất trên bề mặt): hết lốm đốm; còn mảng trắng hai bên đầu/cổ, cẳng
  tay — màu áo từ ảnh back lệch bóng.
- r78: bỏ ảnh back, vùng không thấy lấy màu từ texture Pixal3D r49 (khớp khung bao): TỆ HƠN — hai mesh khác hình
  khối (bím tóc đổi chiều cao) → tóc đen trùm mép mặt, mảng đen trên áo.

Chưa có texture dùng được cho mesh Hunyuan. Hướng còn lại: ảnh back/side KHỚP bóng mesh (vd. sinh ảnh có điều
kiện từ bóng/pháp tuyến của chính mesh), hoặc khớp hai mesh bằng ICP thay khung bao.

Soát lại (người dùng: "texture không khớp mesh"): bóng nhìn thẳng của mesh so với ảnh front_0, khớp khung bao:
Pixal3D r49 IoU **0,906** (căn theo pixel — đúng thiết kế "pixel-aligned"); Hunyuan r72 IoU **0,797** — tay buông
thấp hơn, tay áo khác, tóc khác. Hunyuan3D Shape là model sinh có điều kiện DINO, KHÔNG bám pixel ảnh vào → chiếu
thẳng ảnh ref lên mesh của nó (r75–r78) lệch từ gốc, không sửa được bằng cách lấp. Lẽ ra phải đo IoU này TRƯỚC khi
dựng chế độ `project` (con số 0,79 đã in ra ở r75 mà không dừng lại). r75–r78 không phải Paint. Paint chính chủ
trên mesh Hunyuan (cặp đúng thiết kế) chưa chạy.

### Paint trên shape Hunyuan + vá VRAM (r79–r85)

Vá VRAM (`offload: "parts"`, mặc định): DINOv2-giant + CLIP text/image encoder để CPU, đưa lên GPU đúng lúc gọi
(image_encoder thậm chí không được gọi); VAE giải mã từng ảnh (slicing); `_execution_device` ép cuda. Multiview đỉnh
torch **7,3 GB** (r66 không vá: 13,7 GB tràn), **33–41 s** (r66: 224 s). Cả card đỉnh 10,3–11,2 GB (gồm desktop).
Tổng một lượt ~2 phút (xatlas 25–31 s, inpaint 21 s). r79 lỗi gọi `.to()` lên DINO đã bọc → đã sửa.

Tóc (người dùng: "đuôi tóc r72 bị cụt"): seed 3 (r80) cũng cụt; seed 0 (r70) và seed 5 (r81) bím dài buông xuống gáy.

Paint chính chủ trên shape Hunyuan (r82 ← r70, r83 ← r81): texture KHỚP hình khối (sinh theo pháp tuyến của chính
mesh), phủ kín, lưng/bím/dây buộc đúng màu. Mặt mềm hơn Pixal3D (mắt thành khối đen), quanh tai lem cam như r66.

Rig cấu hình r63: **r84 (r82) p999 1,7–2,6, max 3,5–5,2**; r85 (r83) 1,7–2,5 / 5,5–8,3; r63 (Pixal3D) 1,7–3,0 /
5,7–9,2. Animation có texture sạch.

### Matte, r49 thành một vỏ, sửa vùng không thấy (r86–r92)

Người dùng: r63 (Pixal3D) mesh đẹp hơn nhưng rig lỗi; Hunyuan "như sáp bóng", còn lem, rig gọn.
- Bóng như sáp: map MR của Paint roughness TB 0,48 (p10 0,23); Pixal3D 0,99. `matte` (mặc định) bỏ map MR, metallic
  0 / roughness 1 — r86 (6 góc), r87 (9 góc: tai lem cam bớt chút, card đỉnh 11,6 GB — sát). Rig r90 (r87): p999
  1,7–2,7 / max 4,3–7,0.
- r88 `mode: "transfer"`: r49 → voxel 0,0015·H → vỏ kín 200k mặt, màu chép từ lớp NGOÀI texture r49 (k=16, pháp
  tuyến cùng chiều; 99% điểm cùng chiều). Vẻ ngoài gần y r49. Nhưng rig r89 TỆ (max 20,9): voxel HÀN vạt áo với hai
  ống quần → màng giữa hai đùi (giãn LeftUpLeg↔RightUpLeg). Lỗi rig của r63 không chỉ do vỏ hai lớp mà do các bề mặt
  Pixal3D sát nhau; Hunyuan sinh ra đã tách.
- r91/r92 `mode: "repair"` (vẽ lại texel ảnh front/back không thấy từ texel đã thấy gần nhất): ước lượng "đã thấy"
  bằng `back_project` coi 83% (r91) / 75% (r92, bỏ dải mép) bề mặt là chưa thấy; vệt dưới cằm còn, tai bị tô tối.
  Không dùng.

### Pixal3D thêm ảnh profile trái (r93–r102)

Người dùng thích style Pixal3D. Ảnh profile trái từ Qwen, front_0 của r38 làm `<image2>` (extraRefs) để khớp dáng:
r93 4/4 đúng hướng nhưng tay giơ THẲNG RA TRƯỚC (front: dang ngang). r94 nói rõ "tay gần chĩa về camera, ngắn lại,
không tay nào vươn ra trước" → left_1 đúng nhất.

Pixal3D front_0 + back_0 + left_1 (cùng ảnh r49 + một profile): ~2 phút, card đỉnh 10,8–11,1 GB.
- **r95 (seed 11): hết hai vệt đen dưới cằm, tai màu da không in lên tóc** — đúng hai lỗi người dùng chỉ. Mắt xanh
  xám đúng ref, mặt tròn/mềm hơn r49 chút. Tóc ngả nâu sẫm, đai ngả xanh rêu.
- r96 (seed 7): mắt xanh lá, vệt sọc ở cổ.
(Khác lần 4 góc ở r0x: profile ở đây được khớp với ảnh front bằng `<image2>`, và chỉ thêm MỘT góc.)

Rig r95 (cấu hình r63, 6 lượt seed 0–4 + mặc định): MIA đặt CỔ TAY SAI ở 5/6 lượt (bàn tay rủ + kéo dài ở T-pose,
p999 5–7,8, max 19–35). Chỉ r98 (seed 0) đúng tay: p999 1,9–4,0, max 9–21, giãn giữa hai đùi (vạt áo/ống quần) như
r63. Mesh r49 không bị lỗi cổ tay kiểu này → nghi tay trong mesh r95 khác (ảnh profile ảnh hưởng hình tay).

Người dùng: "mesh tốt hơn hẳn sao rig kém hơn — có xử lý mesh trước khi rig không?" Có (`prep`). Soát:
- Khớp: ở lượt hỏng, Hand trùng khuỷu (r97: LeftHand x 0,475, LeftForeArm 0,481 — cẳng tay ≈ 0); lượt đúng cẳng tay
  0,19–0,23.
- Prep KHÔNG bỏ mất bàn tay, nhưng mesh prep (voxel 0,003·H) THỦNG lỗ chỗ — vỏ hai lớp Pixal3D dày ~0,004·H, xấp xỉ
  voxel → chỗ mỏng biến mất; r95 thủng nhiều hơn r49 ở thân/mặt. MIA đọc điểm + pháp tuyến từ chính bản này.
- voxel 0,0015, cùng seed 1/2/3 đã hỏng: r103–r105 **3/3 cổ tay đúng** (cẳng tay 0,18–0,22), p999 1,8–4,6, max
  3,7–12,6; còn giãn ở đùi/hông (vạt áo phủ ống quần), bằng mắt ngang r63.
- r49 với 0,0015 (r106/r107): cổ tay đúng, p999 1,7–3,7, max 3,4–10 — ngang r63 (r63 là dự đoán đã chọn lọc).
→ Mặc định prep đổi sang 0,0015.

### Dải da trên tay áo — `sleeveSkinFix` (r108)

Best mới: ref r38, mesh r95, rig r105 (người dùng: "r105 tốt nhất hiện tại"). r107 (mesh r49) vẫn vệt cằm + tai —
đúng, đó là lỗi của mesh r49; r106/r107 chỉ để đo prep.

Người dùng: tay áo r105 "như vẽ da trên tay áo". Ảnh cận r95: dải màu da ngay trong viền tay áo, cả hai tay, trước
lẫn sau. r49 cũng có. Gốc: front_0 (r38) vẽ tay áo rộng, hở — thấy da bắp tay qua miệng tay áo. Mesh không có lòng
trong → da đó nằm trên mặt vải.

Sửa ở texture, giữ mesh: khoảng cách đỉnh tới trục vai→khuỷu→cổ tay (khớp của lượt rig) theo đoạn dọc cẳng tay —
da cẳng tay p90 0,019–0,022·H; vải tay áo p50 0,033–0,042, p90 ~0,055. Ngưỡng 0,026 lẹm một mảng da cẳng tay phải
sát viền; 0,032 sạch (11 625 mặt, 24 874 texel). Màu da: R > B + 18 (vải trắng ngả tím B ≥ R); nới 4 px lấy viền
nâu xám, trừ xanh đậm của viền tay áo. Tô bằng màu vải trung vị (246, 238, 249) × độ sáng gốc kẹp 0,93–1,03.

r108 = r105 + `predFrom`/`skinFrom` r105 + `sleeveSkinFix`: POSITION, JOINTS_0, WEIGHTS_0, TEXCOORD_0 trùng byte với
r105; 34 821 texel đổi (gồm viền mềm). Ảnh cận: hết dải da, cẳng tay nguyên. Còn vệt sáng nhạt nơi dải cũ.

### Chạy sạch từ đầu tới cuối, seed mới (r109–r115)

Người dùng: chạy lại một run sạch, không dùng lại seed, để soát flow.
- r109-ref: prompt mặc định v2, front + back, batch 2, cỡ mặc định 896×1152 (r38 là 1152²), seed tự sinh. ~41 s.
  Chọn front_1 (dang rộng, tay áo tách thân, lòng tay áo xám — không lộ da) + back_0 (đuôi tóc khớp front).
  Cả hai front thiếu viền tay áo xanh xám của traits.
- r110-ref: profile trái, prompt r94 + `<image2>` = front_1, batch 4 → CHỈ left_3 đúng (tay chĩa camera); 0–2 vẽ tay
  chỉ thẳng ra trước. Prompt profile chưa nằm trong mặc định server.
- r111–r113 mesh, seed ngẫu nhiên 53826 / 6357 / 249: r112 tốt nhất — tóc ĐEN, viền cổ + tay áo xanh xám đúng, tay
  áo không có dải da. r111 tay áo lem xám; r113 đai xanh lục, dải da trong tay áo, vệt tối trên mặt.
- r114-rig r112, mặc định + `sleeveSkinFix`: cổ tay đúng (cẳng tay 0,24/0,22), đỉnh VRAM 2,7 GB.
  Độ giãn (16 khung/clip) r114 vs r108: p999 1,73–3,16 vs 1,78–3,56; max 5,2–15,2 vs 3,7–11,5.
- LỖI `sleeveSkinFix` ở r114: nới mặt nạ trên UV lấn sang mảnh UV kề bên → tô lốm đốm lên ngón tay, cẳng tay. Sửa:
  chỉ nới vào texel TRỐNG (không thuộc mặt nào khác), viền mềm kẹp trong vùng tay áo. r115 (= r114 qua
  predFrom/skinFrom): 9 510 texel đổi, tô đỏ lên mesh soát 4 góc + cận — chỉ còn vài đốm ấm trên mặt tay áo.

### Nâng khớp gối — `kneeRaise` (r116–r118)

Người dùng: r108 ổn hơn r115, nhưng "đầu gối hơi thấp". Đo: gối r105/r108 ở 0,579 (trái) / 0,570 (phải) quãng hông →
cổ chân; người ~0,5. `kneeRaise` dời khớp LeftLeg/RightLeg dọc xương đùi (đuôi xương đùi dời cùng đoạn — đuôi của MIA
lệch đầu xương con ~0,004, không trùng), trước khi tính trọng số. Cùng dự đoán r105 (predFrom), SkinTokens tính lại.

| lượt | kneeRaise | gối (T/P) | p999 | max |
|---|---|---|---|---|
| r108 | 0 (skinFrom r105) | 0,58/0,57 | 1,78–3,56 | 3,7–11,5 |
| r118 | 0 (đối chứng, trọng số mới) | 0,58/0,57 | 1,85–3,50 | 4,8–11,8 |
| r116 | 0,05 | 0,53/0,52 | 1,90–3,64 | 5,0–20,2 |
| r117 | 0,08 | 0,50/0,49 | 1,80–3,55 | 3,7–12,0 |

Mỗi cấu hình MỘT lượt SkinTokens (không tất định) → r116 max cao chưa chắc do gối. Nhìn ngang ở khung gập sâu nhất
(Run/Jump/Walk): r108 gập ở xà cạp dưới ống quần; r116/r117 gập ở chỗ phồng của ống quần, ống chân thẳng.

### Trang review animation (2026-10-16)

Người dùng: trang review gồm nhân vật (nút Save) × animation Mixamo tải về, phân loại tag. Dataset HF trên máy (2453
clip) đặt tên bằng hash; thử md5 của ~25 tên Mixamo phổ biến (có/không `.fbx`, chữ thường, `_`) — không trùng →
người dùng chọn tải lại từ mixamo.com bằng token của họ.

Kiểm ghép clip trong trình duyệt TRƯỚC khi viết trang: Walk (FBX HF) → GLB khung + clip (armSpace 30) so với clip
Walk trong r108 rigged.glb. Gán thẳng giá trị: lệch tới 0,086 (quaternion) — tư thế nghỉ nhân vật khác khung Mixamo
(vd LeftUpLeg nghỉ [-0,003 0,064 -0,998 0,026] vs [0 0,021 1 0]). Đổi khung `nghỉ_nv · nghỉ_clip⁻¹ · q`: ≤ 7e-7 ở
20/22 xương; hai cánh tay 0,02–0,027 (armSpace tính trên khung khác). Hips: đổi về khung nghỉ rồi khoá in-place giữ
loc[1] → 8e-6 (giữ loc[0] hay loc[2] thì lệch 11–115). Chụp màn hình bằng Edge headless (swiftshader): r108 + Walk,
r117 + Run phát đúng.

Token Mixamo: API `/api/v1/products?type=Motion` → 2446 motion (26 trang × 96). Export FBX không skin, 30 fps, khung
`mixamorig:*` (66 node), ~7,1 s/clip tuần tự + nghỉ 1 s → ~4,8 giờ cho cả kho. Tag (luật từ khoá trên tên + mô tả):
bản đầu 146 clip không tag, `idle` 612 trong đó 305 chỉ vì chữ "Standing"; cung bị gắn `gun` ("Aim") và
`bow-gesture` ("With Bow"). Sau sửa + luật loại: 19 clip không tag; `idle` 308; `bow-gesture` 4 (đều đúng).

### Trang review: arm space trên khung nhân vật + né đầu (r108)

Người dùng: "chibi đầu to, cho tay mở rộng ra đỡ vướng đầu"; nền trang review chói → nền tối (#17181c).
- Arm-space chuyển từ nướng-vào-clip (khung Mixamo) sang trang (khung nhân vật). Bản Python chép đúng đường JS vs clip
  Blender rig.py (r108 Walk, 30°): lệch tối đa 0,029°, không arm-space thì lệch 30°.
- Đo tay chạm (KD tới đỉnh đầu/thân < 0,02·H; khớp Hand + đầu ngón + giữa cẳng tay; 74 clip, 40 khung/clip):

| arm-space | chạm đầu (khung / clip) | chạm thân (khung / clip) |
|---|---|---|
| 0° | 13,6% / 27 | 34,3% / 54 |
| 30° | 14,2% / 24 | 9,1% / 32 |
| 45° | 14,2% / 25 | 6,4% / 21 |
| 60° | 14,8% / 28 | 6,1% / 22 |

- Né đầu bản 1 dùng elipxoit hộp bao + margin: Wave không kích hoạt — nghi tiêu chí hụt ở má, nhưng chụp ngang khung
  148 thì tay ở trước ngực, KHÔNG chạm (camera thấp làm tay chồng lên má). Bản 2: gần bề mặt thật (< margin) HOẶC
  lõi elipxoit 0,8. 60 clip, arm-space 30: tắt 7,19% khung / 16 clip; margin 0,025 → 0,05% / 1 clip (góc p90 23°, max
  58°); 0,04 → 0% (p90 30°, max 70°). Chọn 0,025. Cheering (32/40 khung chạm): trang xoay L ≤41°, R ≤36°, tay giơ
  hai bên đầu.

### Xé ở bàn tay khi phát clip — trọng số rò (r119–r120)

Người dùng: "place animation bị xé mesh chỗ bàn tay". Đo giãn cạnh vùng Hand/ForeArm (r108 rest + clip FBX + armSpace 30,
30 khung/clip, 80 clip đầu kho): max giãn p50 4,01, p90 6,79, 64/80 clip > 3×, gần như toàn TAY PHẢI. Cạnh giãn nhất:
đỉnh ngay sau cổ tay phải (t 1,02–1,05 dọc khuỷu→cổ tay) trọng số RightHand 0,83–0,91 + **RightToeBase 0,02–0,06**.
Gốc: `limb_weight_fix` chỉ chạy ở nhánh `elif weight_fix` (đường MIA); SkinTokens bỏ qua.
- r119: luật chuỗi sau SkinTokens + sau chép về mesh gốc (bỏ 0,37% trọng số, 3179 đỉnh trên prep; 0,05% sau chép).
  Tay: p50 2,86, p90 3,43, 35/80 > 3×, tệ nhất 3,75. NHƯNG toàn thân: Jump max 11,5 → 82,5, Run 11 → 81 — đáy quần:
  luật cũ cấm UpLeg trội giữ UpLeg bên kia → hai đỉnh sát nhau mỗi bên 0,95 một đùi.
- r120: cho UpLeg giữ UpLeg bên kia. Tay như r119; 6 clip mặc định ngang r108 (p999 1,79–3,57, max 3,7–11,2).
  Cận Hurricane Kick khung 54: dải da kéo từ cổ tay xuống hông ở r108 mất ở r120. Best → r120.

### Ref nắm tay (r121–r126)

Người dùng hỏi rig ngón hay gen mesh nắm tay sẵn. Rig ngón không ra nắm đấm: tay Pixal3D là một tấm liền (ref "fingers
together"), ngón không tách; noFingers vẫn giữ. Thử ref nắm tay: prompt v2, thay "hands open, palms facing down, fingers
together" bằng "both hands closed into loose fists (fingers curled in, thumbs resting over the fingers)…".
- r121 (front + back, batch 2): 4/4 nắm tay; tay áo có viền xanh xám, lòng tay áo KÍN (không lộ da — hết gốc của
  dải da tay áo). Chọn front_0 + back_0 (back_1 dang gần ngang).
- r122 profile (prompt r94 + nắm tay, `<image2>` = front_0): 2/4 đúng (left_1, left_2), chọn left_2.
- r123–r125 mesh (seed 67794 / 99628 / 31242): cả ba ra nắm tay, tay áo sạch. r123 đai ngả tím; r124 mắt tím + vệt dọc
  giữa mặt; chọn r125.
- r126 rig r125 mặc định (đã có lọc rò): cẳng tay 0,24/0,23. Toàn thân p999 1,63–2,99, max 4,1–12,1 (r120: 1,79–3,57 /
  3,7–11,2). Chỉ cạnh xương Hand, 80 clip: r108 p50 4,09 / p90 7,21 / 61 clip > 3×; r120 1,69 / 2,36 / 0; r126 1,66 /
  2,08 / 0 → xé bàn tay là do trọng số rò, nắm tay chỉ thêm chút. Cạnh giãn nhất còn lại của r126 ở gần khuỷu (t 0,31,
  trộn Arm/ForeArm trong tay áo) và gối — kiểu giãn LBS khi gập.
- Trang review, Punching Bag: r120 thế thủ bằng bàn tay xoè (như chém tay), r126 nắm đấm.
- Tag: "Jogging With Box" bị gắn punch (`\bbox`) → `\bbox(ing|er)\b`.
(Lưu ý đo: tập "80 clip đầu" lấy theo tên đã sắp, kho đang tải thêm nên tập đổi dần giữa các lần đo cách xa nhau;
ba số Hand-only ở trên đo liền nhau.)

### Mặt chiếu từ ref (r127–r128)

Người dùng: "tay nắm ok rồi mà sao texture mặt tô thấy ghê vậy". r125: đồng tử dọc như mắt mèo, viền mi dưới đen dày,
chấm lấm tấm dưới mắt, má hồng mảng cứng. Ref r121 mắt tròn, đồng tử bầu dục mờ, có đốm sáng. Ảnh Pixal3D nhận
(`mesh_views/front.png`, 1024², nền đen) của r95 và r125 gần như trùng ở vùng mặt → lỗi ở bước tô của Pixal3D, không
ở ref. Ghép cận mặt 40 lượt mesh của project: mặt đổi mạnh theo seed, r123/r124/r125 cả ba xấu, r95 thuộc số ít sạch.

`face_from_ref` (rig.py, cờ `faceFromRef`), thử trên mesh.glb r125/r124/r95 rồi trong rig:
- Bản đầu (script nháp, chiếu bao lồi da, ngưỡng hướng 0,3–0,65): mặt đúng ref; còn vệt nứt mảnh khắp mặt (viền đảo
  UV giữ màu cũ) và cung mảnh dưới mắt. Dò căn bằng vẽ lại 300k tam giác mỗi lần thử: 10 phút → đổi sang warp mặt
  nạ: 7 s.
- Loang phần chênh màu ra khe UV: hết vệt nứt. Cung dưới mắt còn — hạ ngưỡng hướng (0,05–0,3) không đổi gì → là
  tam giác mảnh hơn texel trên gờ quanh mắt cũ; loang vào mọi texel không thuộc tam giác ngoài vùng mặt: mờ hẳn.
- Thử lấp lỗ thay bao lồi (để khỏi chiếu tóc mái lên trán): mắt chạm tóc ở đuôi nên không thành lỗ kín → mắt cũ
  hiện lại. Quay về bao lồi, cắt từ ngang lông mày trở lên (0,2–0,32·bề ngang mặt). Sợi tóc còn thấy trên trán là
  texture gốc của Pixal3D.
- r127 (r126 + `faceFromRef`, predFrom/skinFrom r126): BỎ QUA — IoU bóng cả người 0,788 < 0,85: trong cảnh rig mesh ở
  tư thế nghỉ Mixamo, tay lệch ảnh front. Đổi: IoU chỉ tính ở dải đầu (tới 1,3·bề ngang mặt), phóng quanh đỉnh đầu,
  dò thô ±8% / ±24 px rồi tinh. mesh.glb r125: IoU đầu 0,903; rest.glb r127: 0,892, tỉ lệ 1,02, dịch (−4, 4).
- r128 = r127 với bản sửa: chiếu xong (30 095 texel, 56 779 texel khe). rest.glb so r126: POSITION, TEXCOORD_0,
  JOINTS_0, WEIGHTS_0 trùng byte; NORMAL lệch tối đa 0,04° (cặp r105/r108 cũng đúng mức đó). Cận mặt trước + 3/4
  trên rest.glb: mắt, miệng, má như ref. Lưu vào trang review.

### Review gate + bỏ profile (r129–r139)

Người dùng: ảnh review mesh r125 đã thấy vệt đen ngay lúc đó — phải đánh fail rồi gen lại; mỗi bước có kết quả
phải có review (tạm Claude, sau thêm model local). Ghi review cho r121–r138 (trước đó trống từ r121).
- r129–r134: 6 seed nữa, cùng front_0/back_0 (r121) + left_2 (r122). Cận mặt: r129 vệt đen ngang trán; r130 mắt
  xanh lơ viền trắng, vệt cằm; r131 nốt đen trên má; r132 mắt nhoè hai lớp, vệt dưới cằm; r133 mắt cục đen sọc;
  r134 mất mắt. Cộng r123–r125: 0/9.
- r135–r138: bỏ profile, seed 11/707/808/909. Không còn chấm/vệt/nốt. r135 pass (mắt xám có đốm sáng; hai bên + sau
  sạch, không vệt cằm/màu tai); r136, r137 vệt sáng dọc trong mắt; r138 viền mắt đậm (retry).
- r126–r128 ghi fail: rig trên mesh đã fail (r126), chiếu mặt bị bỏ qua (r127), chiếu mặt bị chê (r128).
- r139: rig r135 mặc định.
- r139 (pass): 6 clip mặc định p999 1,67–2,51, max 4,0–5,7. Hand-only 80 clip p50 1,85 / p90 2,50 / 2 clip > 3× (max
  3,17); r126 đo lại CÙNG tập 1,59 / 2,06 / 0. Khung tệ nhất (Standing Torch Melee Attack 04, f33): cổ tay hơi thắt, không xé.
- r146–r149 (front + back + profile LEFT_1): 0/4 — r146 vệt nguệch ngoạc trán, r147 mảng nâu má, r148 mảng nâu lông
  mày (retry), r149 chấm đen dưới mắt. r150–r153 (front + back): 0/4 — mắt vân lưới, vệt tối cằm (r151, r152, r153).
  Cộng dồn trên ref r121: front + back 1/14, + left_2 0/9, + left_1 0/4.
- Đổi hướng: SỬA ref r38 (ref sau mặt sạch của r95) bằng Qwen, `<image2>` = r38 front_0/back_0, prompt "vẽ lại y hệt,
  chỉ đổi bàn tay thành nắm đấm". r154 front: front_1 giữ góc tay + mặt (chọn), front_0 buông tay sát người (loại).
  r155 back: cả hai đúng, chọn back_1. Tay áo vẫn hở như r38.
- Mesh front + back seed 11/7/42/5 (r156–r159): r157 PASS (mắt xám có đốm sáng, sáu góc sạch, không vệt cằm, không dải
  da tay áo); r156 mắt vân sọc, r158 cả mặt nâu sẫm, r159 mắt trống. 1/4 — lần đầu ra mặt sạch nhanh vậy.
- r160 rig r157: p999 1,87–3,38, max 4,5–13,9; cạnh giãn nhất ở khoeo gối (Jump f10: LeftLeg/LeftUpLeg 42/60, >3× 1405
  cạnh). Gối 56,9%/54,8% (r139 54%, r120 57%). Nhìn bốn góc ở f10: không xé. Pass kèm ghi chú.
- r161 = dự đoán r160 + kneeRaise 0,06 (gối → 50,9%/48,9%), SkinTokens tính lại: max 19,0 (Run), 15,9 (Dance) — không
  đỡ → giãn do hình khối ống quần phồng gập vào khoeo, không do chỗ khớp. Retry.

### Tay áo đúng ảnh gốc (r162–r170)

Người dùng: tay áo trong ref sai hẳn ảnh gốc — gốc là tay lửng một lớp, viền xanh xám bó cẳng tay; ref r38/r154 vẽ tay
loe hở với một lớp mỏng lộ da bên trong, đọc như hai lớp áo → mesh sai chỗ đó, hay lỗi texture (gốc của dải da tay áo
và `sleeveSkinFix`). Một phần do prompt v2 "the short sleeves hang open from the arms".
- r162/r163: sửa r154 front_1 / r155 back_1, `<image1>` = ảnh gốc, "chỉ đổi tay áo cho khớp <image1>…": hết hai lớp, nhưng
  dừng ngang khuỷu (gốc: giữa cẳng tay) → retry.
- r164/r165: thêm "cover the elbow and reach HALFWAY DOWN THE FOREARM… cuff wraps snugly around the middle of the forearm":
  front_2 khớp gốc (chọn), back_3 dài nhất (chọn, vẫn ngắn hơn front chút).
- Mesh front + back seed 11/7/42/5 (r166–r169): cả bốn tay áo một lớp, viền bó, không dải da. r167 pass (mặt sạch; đai +
  cổ áo ngả xanh lục), r169 retry (màu đúng; mảng trắng lấm tấm sau gáy, chấm mũi), r166 mắt xanh lục, r168 mắt nhoè.
- r170 rig r167: p999 1,89–3,16, max 4,7–9,3 (Run 9,3 giữa hai đùi). Hand-only 80 clip 1,80 / 2,33 / 2 clip > 3×.
  Run f15 bốn góc không xé. Pass.

### Soi kỹ + đai sau lưng (r167–r186)

Người dùng bắt ở r170/r167: mắt + lông mày lỗi, dư một ít dây buộc tóc xanh, lòng tay áo + da tay bên trong xấu — tôi
chỉ xem cận mặt chính diện + turntable thu nhỏ nên lọt. Thêm `detail_shots` vào render.py (cận mắt trước/3/4, dây
buộc sau/bên, cẳng tay nhìn từ dưới và từ sau), trang mesh hiện "Detail". r167, r170 → fail.
- Người dùng bắt tiếp: ảnh back vẽ vạt đai thòng giữa lưng, trong khi đai chỉ thắt MỘT nút ở hông trái phía trước →
  Pixal3D dựng hai bộ vạt (r167 thấy vạt sau lưng). Mọi ảnh back đều vậy (r38, r121, r165). Huỷ r174–r178.
- r179: sửa r165 back_3 — bản đai trơn, nút ló mép hông trái (back_0), back_2 mất đai; tay áo vẫn ngang khuỷu.
  r180: sửa back_0 chỉ độ dài tay — lần này dài quá gần cổ tay; back_1 gần front nhất (chọn).
- r181–r186 (r164 front_2 + r180 back_1, seed 11/7/42/101/202/303): 0/6 qua soi kỹ. Lặp lại: mảng dây buộc tóc thừa
  5/6, mắt loang/sai màu, lông mày khúc đậm; đường đen vòng cổ tay (r181, r186); r181 bàn tay xoè ngón.
- Người dùng: r103/r108 (mesh r95) mặt ổn, không lỗi tóc — khác gì? Tham số Pixal3D giống hệt (12/20/12/12 bước, 1536,
  texture 2048, fov 20). Khác ở ẢNH VÀO: r95 có 3 ảnh front + back + PROFILE TRÁI vẽ từ chính ảnh front (r94 left_1);
  từ r135 tôi chỉ dùng front + back (bỏ profile vì r122 làm hỏng mặt — nhưng r122 vẽ từ ref r121 vốn hỏng sẵn).
- r187: profile trái cho bộ ref đã sửa (`<image2>` = r164 front_2, prompt r94 + nắm tay + tay áo viền bó + nút đai hông
  trái): 1/4 đúng dáng (left_3).
- r188–r193 (front r164 front_2 + back r180 back_1 + left r187 left_3): dây buộc tóc MỘT chỗ ở 4/6 (r189, r190, r192, r193),
  r191 ló thêm mẩu nhỏ — profile chữa được lỗi dây buộc thừa (front + back: 5/6 dính). Mặt: r192 gần r95 nhất (pass), r191
  mắt đẹp nhưng da lên tay áo, r193 đồng tử loang, r188 tay đen + tóc loang, r189 mắt nhiễu, r190 vòng viền thừa cổ tay.
- r194 rig r192: p999 2,1–4,4, max 3,7–16,1 — giữa hai đùi (Run f16 LeftUpLeg/RightUpLeg 42/60, >3× ~1900 cạnh): vạt áo
  liền căng giữa hai chân; vòng xám ở cổ tay lộ khi cử động. r195 (cùng khớp, SkinTokens lại): max 4,7–14,8 — do hình khối.

### Sheet ba góc một lần sinh (r196–r217)

Người dùng: tay áo lỗi nặng, 4 lông mày, tóc rối, bàn tay bẩn; đừng dùng lại seed; mesh chưa chuẩn thì đừng rig; đừng
đưa bản tự chấm 62; muốn một FLOW ổn định cho mọi ref. Kiểm lại:
- Tham số Pixal3D khớp template ComfyUI (bước 12/20/12/12, CFG 7,5, CFGOverride/RescaleCFG, upsample 1536) — không sai.
- Ảnh vào r192: front rộng 373 px, back 484 px — tay front buông, tay back dang (ba ảnh từ ba lượt sửa rời). Pixal3D
  trộn ba dáng tay → tay áo/bàn tay hỏng, mặt nhiều lớp.
- r196: Qwen sinh MỘT sheet front | left | back (2048×1024, `<image1>` = ảnh gốc), 4 ảnh ~70 s, đỉnh 11,5 GB. Cắt:
  cao ba góc lệch ≤ 2%, bề ngang front/back lệch 0–1,8%. sheet 1 back xoè tay (loại); 0, 2, 3 dùng được.
- r197–r204 (sheet 0 và 3, seed ngẫu nhiên): tay áo một lớp viền bó, MỘT dây buộc, một bộ vạt đai, nắm tay — 8/8. Mặt:
  0/8 (mắt tím/đỏ/vân/loang, vệt má).
- A/B cùng seed: `textureSteps` 24 — r205 mắt đổi hẳn (không tốt hơn), r206 gần y hệt; bỏ profile — r207 mắt mèo,
  r208 tròng sọc → giữ ba góc, giữ 12 bước.
- Kho Mixamo tải xong: 2443 sản phẩm, 2434 ok, 9 lỗi; index 2298 clip, 18 chưa gắn tag.
- r197–r204, r209–r217 (17 mesh từ sheet, seed ngẫu nhiên): MẶT pass 1/17 (r213: mắt xám đậm có đốm sáng, lông mày mảnh,
  một dây buộc, tay áo + bàn tay sạch). Lỗi mặt còn lại: mắt tím/đỏ/xanh lơ, tròng sọc/vân, vết cào/râu trên má.
- r218 rig r213: max 8,5–32,8 — vạt áo hàn thành màng nối hai đùi (Run f15 2302 cạnh > 3×, LeftUpLeg/RightUpLeg 48/60).
  Thử vá ở rig, cùng dự đoán + trọng số (predFrom/skinFrom r218): chuyển phần trọng số CHUNG hai đùi về Hips (numpy) →
  max 46; `legSmooth` (mượt Laplace vùng trộn hai chân, như armSmooth) 150 vòng → max 29,6, p999 tăng; 400 → 52,9. Loại
  cả hai — giãn do hình khối, rig không cứu. Cờ `legSmooth` để mặc định 0.
- Paper Pixal3D (arXiv 2605.10922): nhiều góc = chiếu ngược đặc trưng từng ảnh vào khối 3D rồi LẤY TRUNG BÌNH trong
  từng voxel; giả định camera đúng; không bàn ảnh mâu thuẫn. Giả thuyết: voxel mặt nhận cả đặc trưng góc khác.
- So tỉ lệ mặt pass trên cùng sheet r196 (soi Detail, seed ngẫu nhiên): ba góc 2/29 (r213, r223; r221–r232 thêm 1/12);
  CHỈ front 1/6 rõ (r235, mặt đẹp nhất tới nay) + 1 tạm (r236) — nhưng lưng bịa (r235: mảng sẫm như áo khoác trên lưng,
  đai sau thiếu). Mẫu nhỏ, nghiêng về một ảnh cho mặt tốt hơn, khớp bảng cũ "chỉ front: mặt sắc nhất".

## Ghép mặt: hình r223 + mặt r235 (r239, 2026-10-17)

Ý: bản ba góc đúng hình/lưng/đai, bản chỉ-front đẹp mặt → chép texture vùng mặt từ bản chỉ-front sang bản ba góc.
Script `graft_face.py` (scratchpad, chạy bằng venv mia-rig). Năm lần thử đầu hỏng, mỗi lần một bài:

- **Căn theo bóng dải đầu → lệch mắt.** Hai bản khác tóc (búi, độ xù), IoU đầu 0,78, mắt B lệch hẳn mắt A.
  Căn theo bóng CẢ NGƯỜI (IoU 0,84) rồi tinh bằng tương quan ảnh xám vùng mắt-mũi-miệng (NCC 0,68 → 0,74) thì mắt trùng.
  Hai bản lệch tỉ lệ: Pixal3D chuẩn hoá mỗi bản theo hộp bao riêng (r223 cao 0,99, r235 cao 0,90).
- **Điểm gần nhất 3D → mắt loang đen trắng.** Hõm mắt r223 sâu hơn r235 1–2% H; điểm gần nhất nhảy sang tóc/mí.
- **Điểm gần nhất dọc tia nhìn → vệt cung trắng trong mắt.** Trúng mặt trong khuất của B (tô bừa). Đúng là lấy
  bề mặt B NHÌN THẤY từ trước (điểm trúng đầu tiên từ phía camera), gác cổng 3% H dọc tia.
- **Mặt nạ lấy cả trán → mất lông mày, mảng da sáng.** B có mái che lông mày. Mặt nạ bắt đầu ngay trên mép mắt;
  mép mắt tìm bằng đi ngược từ tâm mảng tối, dừng ở hàng hẹp hơn 0,08·bề ngang mặt (mảng mắt dính sợi tóc).
- **Lọn tóc mai A nhận màu da B** (nằm sát má, trong cổng). Ngoài vùng mắt chặn đổi chéo tóc tối ↔ da sáng.
- Phụ: nới ngang mặt nạ ở dải mắt (đuôi mắt A sót quầng sáng), bỏ màu vải dưới tầm miệng (cổ áo nhoè),
  hệ số tông da theo kênh (r235 sáng hơn).

Kết quả r239: mắt của r235, sạch, có đốm sáng; lưng/đai/tay áo/nắm tay/một dây buộc của r223. Tự chấm 77 pass.
Còn: miệng mờ (r235 không vẽ miệng), vệt nâu nhỏ mép một lọn tóc mai ở góc 3/4, chưa soát màng vạt áo giữa đùi.
Lưu ý: r223 dùng sheet 0, r235 dùng sheet 3 — khác ảnh front mà vẫn căn được nhờ NCC vùng mặt.

### r239 bị bắt hai lỗi → r240

- **"4 chân mày"** — mỗi bên mắt: lông mày r223 + nét xám mờ + viền mi r235. Nét xám là SỢI TÓC MÁI của r235
  (vắt ngang mắt nó) in lên da r223; thêm đoạn viền mi cũ r223 sót lại. Mốc mép mắt theo mảng tối thì dính tóc
  (ra hàng 266, tròng thật ở ~326). Sửa: mắt nhận bằng MÀU TRÒNG (B > R + 10); bỏ qua lớp tóc treo của B (bắn tia
  tiếp qua mặt màu tóc tới mặt không phải tóc, ≤ 4% H); giữ sợi tóc treo của A (texel tối, sau nó qua mặt màu tóc
  gặp DA xa > 0,6% H); bước loang mép UV không lấn texel đã bị chặn (đó là chấm đen). Luật màu tóc↔da giữ làm lưới
  an toàn, dải viền mi B chỉ nới về phía đuôi mắt.
  Bẫy đã gặp: mesh Pixal3D là vỏ mỏng hai lớp — sau da 0,3–1% H đã có mặt trong, "sau nó có mặt" gắn cờ nhầm 29k texel da.
- **Tóc bóng** — KHÔNG do ghép: ảnh ORM của chính r223 có roughness tóc ~0,02 (gương); bản lành ~0,88.
  Quét 113 mesh: 4 dính (r66, r82, r83, r223). Thêm: xuất lại GLB qua Blender làm mất TANGENT + tách pháp tuyến
  (210402 → 210520 đỉnh). Sửa: thay ảnh base color ngay trong GLB gốc (giữ từng byte phần còn lại) + `fix_roughness.py`
  (kênh G < 0,3 → trung vị phần lành), bước bật tay. So EEVEE: r223 bóng ướt, r240 lì như r235.
  Workbench (ảnh review) không thấy roughness → cửa duyệt mesh cần đo roughness bằng số.

### r240 vẫn "4 chân mày" → r241

Bốn nét = mỗi bên mắt: lông mày của CHÍNH r223 (dải nâu dày, nằm cao dưới tóc mái) + viền mi dày của r235. Lông mày
r223 không bị chép đè vì ở đó tra B "quá cổng" (tóc mái hai bản lệch > 3% H) và phép thử sợi tóc treo coi dải nâu là tóc.
Lấy lông mày r235 thay vào (nó bị tóc mái che, lộ qua lớp-hai) thì vỡ thành mảng xám + chấm đen. r241: dải lông mày
(trên tròng B 0,08–0,42·bề ngang mặt) về màu da lấy ngay dưới dải, mép dưới mờ dần; chỉ giữ sợi tóc r223 (tối, trung
tính). Mỗi bên mắt còn viền mi. Ref có lông mày mảnh vẽ đè lên tóc mái — r241 không có.

## Nhân vật mới cau-be-vo-sinh-2 — chạy sạch từ ảnh gốc (2026-10-17)

Người dùng: nhân vật cũ quá nhiều run → tạo nhân vật mới cùng ảnh ref gốc (giống từng byte), chạy flow chuẩn.
- r01-ref: sheet ba góc một lần sinh (prompt r196), batch 4, seed ngẫu nhiên. Khớp front/back: 2,0 / 0,2 / 0,9 / 8,0%
  (s3 loại); cao ≤ 1,9%. Trang phục đúng ở cả 4.
- Mesh ba góc, seed ngẫu nhiên: r02–r07 0/6 mặt pass (r05 retry); r08–r13 **1/6 pass (r08)**. Gộp 1/12 — khớp
  tỉ lệ cũ (2/29). Roughness hỏng: 0/16 lượt.
- Chỉ front (nguồn ghép mặt): r14–r17 → 2/4 mặt sạch (r15, r17), r14 tạm, r16 tóc che mắt.
- r08: mặt, tay áo, dây buộc, đai, nắm tay đạt; hình khối không màng giữa đùi (clay). Vài sợi tóc ánh nâu đỏ sau gáy.
- Chạy từng lượt một, chấm xong mới gen lượt kế (người dùng yêu cầu), r27–r38: 0/12 pass, 1 retry (r36: da sạch,
  mắt đục). Lỗi hay gặp: đồng tử vạch dọc mắt mèo (r30, r33), màu tròng lạ (xanh ngọc, tím, xanh lục, đốm vàng),
  tóc ngả nâu/xanh rêu, áo ngả tím/hồng, lông mày vẽ hai lần (r37). Tay áo/đai/nắm tay/dây buộc đúng ở cả 12.
  Tổng ba góc cho nhân vật này: 1/33 pass (r08, người dùng loại).

### So với Space HF TencentARC/Pixal3D (2026-10-17)

Người dùng thử Space (một ảnh = ref gốc, 1536, seed 42, FOV tự đoán) thấy đẹp. Đọc `app.py` + `pixal3d_image_to_3d.py` của Space:
- Giống arm: tách nền → cắt vuông pad 1,1 nền đen; FOV MoGe-2; structure 12 bước CFG 7,5 rescale 0,7 shift 5;
  texture CFG 1, 12 bước; cascade 512 → 1536; DINOv3 ở 512 và 1024 + NAF (node ComfyUI dựng lại khớp từng bit).
- Khác: (1) Space cho ảnh REF GỐC vào một mình — flow của mình luôn qua sheet Qwen; (2) trọng số gốc, arm dùng
  int8 convrot; (3) shape 12 bước (arm theo template ComfyUI: 20); (4) ảnh trong tab PREVIEW là render mesh voxel
  thô + HDRI, chưa phải GLB đã bake (GLB chỉ có sau "Extract GLB").
- r39 = một ảnh `ref.png`, seed ngẫu nhiên, mọi thứ khác mặc định: retry 75. Tóc đen, áo trắng, đai/dây buộc đúng
  màu ref, không mắt mèo; cận mắt còn tròng loang + vệt trắng đuôi mắt trái. Chưa gặp bản ba góc nào sạch màu toàn
  thân như vậy. Một seed là một điểm.

### Pixal3D multiview bf16 thay int8 convrot (r40–r43, 2026-10-17)

Người dùng: thử trọng số gốc; vẫn dùng sheet (cần nắm tay — ref gốc tay xoè). Dọn ổ E trước (xoá trọng số flux2-klein,
LTX diffusers/sd.cpp + cache offload, Qwen-Image-2.1 Turbo, Z-Image Turbo: 36 → 277 GB trống). `pixal3d_multiview_bf16`
(Comfy-Org/Pixal3D@f37641b, 10 999 317 704 B) là vai tuỳ chọn `unet-multiview-bf16`; job `precision: "bf16"`.
- Máy: 5070 12 GB, card cả máy đỉnh 9 695 MiB (nền ~5 GB của app khác), công suất 214–250 W lúc khử nhiễu → không
  tràn. ComfyUI nhả model trước hậu xử lý (60–80 W lúc remesh/bake). 135–145 s/lượt (int8 ~120 s).
- Ba góc, sheet 0/1/2/0, seed ngẫu nhiên MỚI (người dùng chọn không chạy lại seed int8):
  r40 retry 78 · r41 fail 59 · r42 fail 67 · **r43 pass 85**. Cả bốn: tóc đen sạch, áo trắng, không loang tím/hồng/
  xanh rêu — lỗi màu toàn thân hay gặp ở int8 (r27–r38) không xuất hiện. Lỗi còn lại nằm ở MẮT (tròng xoáy không
  đồng tử r41, đồng tử vạch dọc nhẹ r42, viền trắng dày r40). Roughness hỏng 0/4.
- So int8 cùng nhân vật, cùng sheet: 1/33 pass (r27–r38: 0/12, đa số 41–55 điểm). bf16: 1/4 pass, 3/4 ≥ 67.
  Mẫu nhỏ — chưa đủ để nói tỉ lệ, đủ để thấy màu toàn thân ổn định hơn.
- r44 rig r43 (mặc định: prep + MIA + SkinTokens): pass 83. Giãn max 5,6 (Idle) – 14,3 (Run), p999 1,8–5,2; không rách
  ở 6 clip. Lần đầu nhân vật này có mesh + rig cùng pass.
- Người dùng xem r44: "nắm tay thu vào trong cơ thể" (chạy, xoay người), "chân từ gối trở xuống khi chạy hơi bẹt ra
  hai bên". Đo (scratchpad `hand_in_body.py`: đỉnh trội Hand nằm trong thân theo bán kính quanh trục sống, ≥ 5% đỉnh =
  khung xuyên; soát bằng ảnh 4 góc — Idle khung 65 tay trái chống hông chìm hẳn vào hông, đúng):
  r44 (armSpace 30): 74/240 khung — Dance 26, Idle 21, Jump 14, Walk 9, Run 4, Wave 0. Gối 56–59% hông → cổ chân.
- r45 = predFrom r44 + `kneeRaise` 0,08 + `armSpace` 45: gối 48–51%; xuyên 58/240 (Dance 17, Idle 17, Jump 13, Walk 7,
  Run 4) — −22%, khớp số cũ (30° → 45°: 9,1% → 6,4%). p999 như cũ; max Run 14,3 → 25,5, Jump 12,7 → 20,7 — cạnh tệ
  nhất ở vạt áo/đuôi đai nối HAI ĐÙI (`stretch_where.py`: > 4× đa số RightUpLeg/LeftUpLeg ở CẢ hai bản; `bridge.py`:
  838 cạnh bắc qua hai chân ở 0,20–0,40·H, lệch về bên trái — đuôi đai + vạt trước). retry 78: góc cố định không gỡ
  được tay chống hông/xoay người trên thân chibi to.
- Người dùng: "Walk trong r45 bị lẹm vào người" → cuối clip (khung 41–48/48) chống hai tay sau hông, 76% đỉnh tay
  trái trong thân. Làm **né thân** (`TorsoClearance` trong rig.py + `withTorsoClearance` ở Char3dAnimViewer.vue,
  cùng hằng số: biên 0,006·H, lát 6/đoạn × 24 múi góc, kéo trục 0,2·H dưới Hips, xoay ≤ 70° bước 2°, mượt như né
  đầu). Áp lên clip r44 (armSpace 30): 74 → 0/240 khung (`hand_in_body.py`), độ giãn y nguyên, ảnh 4 góc tự nhiên.
  Bẫy gặp lúc thử: clip nạp lại từ glTF có khoá ở khung lẻ (0,4/0,8…) — ghi đè khung nguyên mà để khoá lẻ là tay
  không đổi; `apply` giờ ghi lại toàn bộ khoá xoay cánh tay theo khung nguyên. Bản JS chạy trong Node (three 0.170,
  rest.glb bỏ texture): góc/tỉ lệ khung khớp bản Python (Walk L ≤70°/51%, R ≤38°/42% vs ≤59°/59%, ≤36°/43%).
- r46 = predFrom r44 + skinFrom r45 + kneeRaise 0,08 + armSpace 30 + né thân: render.py `handInBody` 0 ở cả 6 clip
  (r44 khi đo cùng cách: Dance 17/30, Idle 15/30, Jump 11/30, Walk 6/30, Run 1/10). Góc né: Idle L ≤38° 67% khung;
  Walk L ≤70° 39%, R ≤38° 41%; Dance L ≤40° 97%, R ≤18° 33%; Wave 0. pass 88. Walk thành clip kiểm tra cố định.
- Người dùng xem r46: "walk tay trái bị xoắn 1 vòng". Đo (`arm_jumps.py`: góc xoay thế giới giữa hai ¼ khung): cánh tay
  trái r46 17°/¼ khung quanh khung 43–44 (r45 không né: 3,2°). `arm_offset.py`: góc né giữ ~55° nhưng TRỤC quay từ +z
  qua +x sang −z trong ~4 khung — bàn tay bị kéo vòng cung (y +0,24 → −0,36). Trục bản đầu = vai→tay × vai→trục
  sống: tay ra sau lưng thì hai véc-tơ gần thẳng hàng. Bản hai (vai→tay × trục sống→tay, trục làm mượt): còn 7°/¼
  khung, tay vẫn bị nhấc ~55° rồi quét trước → sau. Bản ba (đang dùng): hướng đẩy = NGANG của thân phía vai (trục
  sống → vai, bỏ thành phần dọc sống) — dang tay như armSpace, góc theo khung; + dấu quaternion liền mạch khi ghi
  khoá. r44 offline: lọt 0/240, bước xoay thêm ≤ 6°/khung; JS trong Node ≤ 5,8°/khoá (60 fps).
- r47 (cùng đầu vào r46): handInBody 0 ở 6 clip; maxStepDeg ≤ 5,3; Walk cánh tay trái 2,6°/¼ khung. r47 pass 88,
  r46 hạ fail 60.

## 2026-10-17 — co-be-vo-sinh-hong: bước ref trên Lightning (r01–r06)

- r01/r02: không chạy — cổng server đòi 10000 MiB trống cho mọi job ComfyUI (`gpuReserve`, chốt cho FLUX.2 Klein đã
  xoá), desktop giữ ~2,4 GB → còn 9,1–9,3 GB. Sửa `gpu.ts`: Ô comfy dùng `reserveMiB` của arm (Lightning 9000). Đo r03:
  4 ảnh 2048×1024 trong 45 s, đỉnh cả card 11205/12227 MiB, 230 W, 39/45 mẫu > 150 W — tính thật, không tràn.
  ComfyUI tự nạp động ("prepared for dynamic VRAM loading"): Trellis2 bf16 10,5 GB staged vẫn đỉnh 9,7 GB.
- r03 (sheet 2048×1024, mẫu sheet của cau-be-vo-sinh-2 r01): 4/4 vẽ BỐN hình (thừa góc lưng; s1 đầu xám trống);
  profile tay vươn ra trước 3/4. Fail 30.
- r04 (1536×1024 + "EXACTLY THREE"): ba hình 4/4; bề ngang front/back 13% (front chạm mép) / 3,0 / 3,5 / 5,4%, cao
  ≤ 1%. Front XOÈ tay 4/4 — chép ảnh gốc; lưng + profile nắm. Fail 55.
- r05: tự sửa ảnh gốc sang nắm tay — bỏ, không xem (người dùng muốn app tự sinh ref).
- r06 (ảnh rời, prompt mặc định v3, 896×1152, batch 4/góc, 75 s): front xoè 3/4 (cái nắm thì tay ngang T-pose);
  profile tay vươn ngang ra trước 4/4; lưng vẽ nút + đuôi đai 3/4, trâm hoa hiện sau đầu 4/4. Fail 35.
- So: Turbo, cùng mẫu sheet, ảnh gốc cậu bé cũng xoè tay → nắm tay cả ba góc 4/4, đủ ba hình 4/4.
- Dựng lại Turbo (code từ git, DiT 6,76 GiB). r07 (ảnh rời v3, Turbo, 105 s, đỉnh 11613 MiB cả card): nắm tay front
  4/4 — Turbo giải được; nhưng ảnh rời sinh độc lập → tay front/back lệch góc (cặp khớp bbox nhất 0,9% thì nắm tay ở
  47% vs 52% chiều cao). Retry 62.
- r08 (sheet Turbo 2048×1024, cùng mẫu r03): ba hình 4/4, nắm tay mọi góc 4/4, ngang front/back 0,5/5,7/1,6/2,4%. Pass 86.
- Mesh bf16 từ r08 (r09–r18, 165–175 s, đỉnh cả card 10880 MiB, 245 W): 0/10 pass. Tốt nhất r10 (74: mắt sạch,
  hồng tối, thừa một trâm). Hỏng mắt 7/10 (xám trống, con ngươi lệch, vân, vệt nước mắt, ô vuông).
  **Hồng pastel tối đi ở MỌI seed**: ảnh vào 222,186,192 → render 174–190 (áo trắng giữ 249 vs 251, nên lỗi tô chứ
  không phải đèn); seed chỉ quyết độ bão hoà (r-g 25–35, ảnh vào 35).
- Người dùng: "hồng lệch tí cũng được nhưng mặt phải chuẩn". Mesh r19–r28 (thêm 10, r22 thử bỏ profile: hồng tươi hơn
  nhưng tóc chĩa ngang như cánh, miệng hé — profile giữ hình đầu). Mắt ảnh gốc là TÍM XÁM (đã chấm nhầm "xám = lỗi").
  r28 pass 80: mắt tím, con ngươi dọc, miệng cười, một trâm, nơ có đuôi; thiếu đốm sáng.

## 2026-10-17 — co-be-vo-sinh-hong: rig, tóc dài làm MIA đặt khớp sai (r29–r37)

| lượt | gì | Hips / vai (·H) | handInBody ≠0 | p999 worst | ghi chú |
|---|---|---|---|---|---|
| r29 | mặc định + kneeRaise 0,08 | 0,56 / 0,80 | 6/6 clip | — | vai trong đầu, tay trái vào đuôi tóc; né thân 64–70° mọi khung |
| r30 | rig lại y hệt | 0,58 / 0,85 | 4/6 | — | cùng lỗi → hệ thống |
| r31 | ĐO: mesh thử đã cắt tóc rủ | 0,43 / 0,60 | 1/6 | — | tóc là nguyên nhân |
| r32 | `prep.hairCut`, tóc chép từ thân gần nhất | 0,42 / 0,60 | 1/6 (Jump 2/30) | 18 (Walk) | xé ở đường cắt Head↔Spine2/Hips |
| r33 | tóc Head → Spine2 theo chiều dài | như r32 (predFrom) | 0/6 | 4,5 | mảng chĩa ngang sau vai phải trong Walk |
| r34 | + nới vùng tóc ra ngoài vỏ | | 0/6 | 5,9 | p999 tệ hơn, mảng còn |
| r35 | + Head ≥ 0,25 bỏ chuỗi tay | | 0/6 | 6,0 | mảng còn, max 86 |
| r36 | + chuỗi tay xa > 0,12·H bỏ | | 0/6 | 6,1 | mảng nhỏ hẳn |
| r37 | r36 bỏ bước nới | | 0/6 | 4,6 | pass 82 |

- prep hairCut trên r28: 29 241/297 985 mặt cắt, cằm 0,694·H. Bản loang theo CẠNH chỉ cắt 7 811 (tóc nhiều lọn rời + vệt
  bóng sáng), argmin bề ngang cho cổ 0,619 (bề ngang phẳng 0,106–0,116·H từ 0,60 tới 0,675 vì tóc quanh cổ).
- Cậu bé r47 (mốc): p999 1,8–5,1, cạnh > 4× chủ yếu UpLeg/UpLeg (đũng quần). Cô bé r37 còn cạnh tóc Head/Spine2 ở
  Idle/Walk/Wave (6–10k so với 40–2 150) — không thấy trên ảnh trừ dải sau vai phải.

## 2026-10-17/18 — co-be-vo-sinh-hong: bỏ dải lụa rủ (người dùng), mesh + rig lại (r38–r47)

- Người dùng: mesh rig chưa đủ tốt, dải lụa buộc tóc rủ khó dựng mesh → bỏ. traits sửa (nơ ngắn ôm gốc đuôi tóc, không đuôi),
  sheet Turbo r38 với câu "ONE change: the long hanging silk ribbon tails of <image1> are REMOVED": 4/4 không dải rủ, ngang
  front/back 0/0,2/1,1/0%. Pass 88.
- Mesh r39–r43 (s0, s3): r43 pass 82 ở lượt thứ 5 — mắt tím hồng, con ngươi dọc, CÓ đốm sáng; trâm tô vàng.
- r44 (rig mới, kneeRaise 0,08): handInBody 0/6, p999 1,8–3,5; cổ tay phải giữa cẳng tay (−0,50 vs mesh −0,71). Retry.
- r45 (rig mới, kneeRaise 0): cổ tay đối xứng; gối 55%. r46 = r45 + kneeRaise: Walk hai tay đưa ngang ra trước — trục X
  LeftArm/RightArm xoắn ~45° (pose MIA). r47 = r46 + đặt lại roll chuỗi tay (Arm 34/52°, ForeArm 23/40°, Hand 150/58°):
  tay buông dọc sườn, né thân Walk 34–36° (r46: 0 — tay không ở gần thân), p999 1,9–3,6, Jump handInBody 4/30 ≤ 9,7%. Pass 84.


## 2026-10-18 — co-be-vo-sinh-hong: người dùng chưa ưng mesh r43, quay thêm seed (r48–r60)

- 13 lượt bf16 trên sheet r38 (s0 ×7, s1 ×3, s2 ×3), seed ngẫu nhiên, mỗi lượt 155–230 s. Không lượt nào pass.
  - Mắt hỏng ở 11/13: xám sọc vân vải/tóc (r49, r54), đen đục (r52, r56, r57), xanh (r58, r60), loang trắng (r50).
  - Má hồng hoá cụm chấm đen ở r48, r51, r55. Trâm nhân đôi hai bên đầu ở hầu hết lượt; bạc ở r58.
  - Miệng cười đúng ảnh vào chỉ ở r59, r60 — cả hai mắt sai màu.
  - Tốt nhất: r53 (retry 72, mặt sạch, thiếu đốm sáng, trán vệt nhăn), r51 (retry 64, cục đen mi dưới).
- Cộng vòng trước (r39–r43): 1 pass / 18 lượt trên sheet r38. Texture chạy 12 bước, CFG 1,0 theo template — chưa thử đổi.

## 2026-10-18 — co-be-vo-sinh-hong: người dùng chê r43 (vệt tóc, trâm sai màu/không ra hình, mặt hồng) → reproject (r61–r63)

- r61 = seed r43 (878613013) + textureSteps 24: hình khối y hệt r43, texture khác hẳn (mắt đỏ sẫm, trâm nâu). Fail 50.
- Thử reproject trên r43 trong scratchpad: affine toàn cục → trâm phía sau xanh lá, vệt nứt đen theo mép đảo UV;
  sửa bằng KNN + loang mép. Không flow → tóc dính da ở mép mặt; thêm flow DIS → đen lốm đốm (flow kéo ra nền) →
  soát mặt nạ lại sau flow.
- Gắn vào runner (`server/utils/char3d-runner.ts`, bước `reproject` sau mesh). r62 = seed r43 qua app: 212 986 đỉnh
  (r43: 211 896 — Pixal3D không tất định tuyệt đối), IoU 0,883/0,897/0,922, texel chiếu 604k/2,32M, reproject 36,7 s. Pass 85.
- r63 rig r62 (kneeRaise 0,08, roll tay mặc định): handInBody 0 ở 6/6; p999 Idle 2,4, Walk 4,2, Wave 3,1, Dance 5,0,
  Jump 6,1, Run 6,8 — cạnh giãn UpLeg/UpLeg (màng đũng). Walk tay buông dọc sườn. Pass 80.
- Người dùng: "mặt tốt nhưng tóc ám hồng". Đo r62: tóc RGB TB 102,89,92 (ref tối 68–87,60–75,63–79, hue 335°) → giảm
  sắc độ tóc (r64 qua Pixal3D lại: hình khối khác, mảng tóc che mắt, tóc loang — retry 66).
- Thêm `retexture` → r65 (hình khối r62): hết hồng nhưng người dùng chê "bẩn như xi măng, mốc trắng". Đo: tóc trung vị
  0,37 vs cậu bé (Pixal3D) 0,12. Thêm `hairLum` 0,13 + gom tóc theo texture cũ + điểm sáng lạc → r67 pass 87.
- r66/r68 rig bằng predFrom r63: r68 ra lại tóc r62 — pickle mang texture cũ. rig.py thay UV + vật liệu theo mesh vào
  (cùng số đỉnh) → r69 pass 82, số đo = r63.

## 2026-10-18 — trang char3d tách ba bước + gallery; review kiểu Mixamo

- Người dùng: tách flow ref / mesh / rig, đầu ra chuẩn vào gallery, người dùng tự chọn chạy bước sau; trang review
  như Mixamo (card clip ở giữa, panel xem bên phải). Dữ liệu cũ: gallery dựng từ lượt pass (cô bé: ref 2, mesh 4, rig 4).
- Sheet chạy trong app (trước đây cắt bằng script ngoài + `picks`): r70 (thử, batch 1) seed 1655548569, ba hình,
  ngang 518/516 px (0,4%), cao 953/945/946 (0,8%), cắt 0,5 s. Chưa review.

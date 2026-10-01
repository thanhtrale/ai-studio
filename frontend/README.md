# frontend

Web frontend tĩnh cho AI Studio: Nuxt 4 + Tailwind CSS 4, build ra static bundle,
đọc/ghi Firebase Storage từ trình duyệt, deploy lên Firebase Hosting.

Đây là package độc lập, **không** nằm trong npm workspaces của repo — cài và chạy
riêng trong thư mục này.

## Chạy local

```bash
cd frontend
cp .env.example .env      # điền Firebase web config
npm install
npm run dev               # http://127.0.0.1:3100
```

## Build

```bash
npm run generate          # → .output/public
npm run preview
```

`ssr: false` + `nitro.preset: 'static'`: không có server runtime, router chạy ở
trình duyệt. `firebase.json` rewrite mọi path về `/index.html` để deep link hoạt động.

## Deploy

Hosting site: `ai-studio-client` (project `forward-camera-345608`). `firebase.json`
khoá cứng `site` và script deploy dùng `--only hosting:ai-studio-client`, nên lệnh
deploy không chạm tới site khác trong cùng project.

```bash
npx firebase-tools login
npm run deploy            # generate + deploy lên ai-studio-client
npm run deploy:preview    # deploy lên preview channel, URL tạm
```

### Rules

Firestore và Storage của project dùng chung với app khác, mà Firebase không có
deploy từng phần — một lần deploy là thay cả file. Nên rules của app này nằm ở
`rules/*.ai-studio.rules` dưới dạng khối rời, và `scripts/sync-rules.py` kéo
ruleset đang chạy về rồi splice khối đó vào giữa hai marker:

```bash
python3 scripts/sync-rules.py --diff    # xem sẽ đổi gì
npx firebase-tools deploy --only firestore:rules,storage \
  --project forward-camera-345608 --config firebase.rules.json
```

Script chỉ chạm phần giữa `// >>> ai-studio` và `// <<< ai-studio`; mọi rules
khác được chép nguyên văn. Bản đang chạy luôn được lưu lại ở
`.rules-backup/*.live.rules` trước khi ghép, dùng để rollback.

`firebase.json` cố ý **không** khai rules, nên `npm run deploy` chỉ đụng Hosting.

## POC truyền tệp P2P (`/p2p`)

WebRTC data channel, Firestore chỉ làm signaling (offer / answer / ICE candidate);
tệp đi thẳng giữa 2 trình duyệt, không qua server.

Cách test:

1. Chèn rules bằng `scripts/sync-rules.py` (xem mục Rules ở trên).
2. Mở `/p2p` trên máy A → **Tạo phòng** → được mã 6 ký tự.
3. Mở `/p2p` trên máy B → nhập mã → **Kết nối**.
4. Khi trạng thái là "Đã kết nối" thì chọn tệp để gửi. Gửi được cả 2 chiều.

Hai đầu **không cần cùng origin**: một máy mở `https://ai-studio-client.web.app`,
máy kia mở `http://localhost:3100` vẫn bắt tay được, vì cả hai cùng nói chuyện với
một document Firestore và WebRTC không quan tâm same-origin.

### Không chiếm RAM

Bên nhận ghi thẳng vào Origin Private File System (`navigator.storage.getDirectory()`)
theo từng chunk, không gom `Blob` trong bộ nhớ; link tải xuống lấy từ file trên đĩa.
Trình duyệt không hỗ trợ OPFS thì tự rơi về chế độ giữ trong RAM, UI có ghi rõ đang
ở chế độ nào.

Bên gửi đọc file theo lát 16 KiB nên cũng không nạp toàn bộ. Hai van điều tiết:

- `bufferedAmount` của data channel — chặn hàng đợi gửi phình to.
- Cửa sổ ACK 8 MB — bên nhận báo số byte **đã ghi xong xuống đĩa**, bên gửi không
  chạy trước quá cửa sổ đó. Thiếu cái này thì mạng nhanh hơn đĩa sẽ dồn chunk vào
  RAM bên nhận. Đây chính là thứ torrent/rsync làm: credit window + ghi theo offset.

Ràng buộc:

- **Phải chạy qua HTTPS** hoặc `localhost` / `127.0.0.1`. Mở bằng IP LAN dạng
  `http://192.168.x.x` thì trình duyệt chặn WebRTC.
- **STUN mặc định, TURN tuỳ chọn.** Khác mạng mà gặp symmetric NAT thì sẽ thấy
  `connection: failed`. Lúc đó điền `NUXT_PUBLIC_TURN_*` trỏ tới một TURN server.
- Candidate subcollection không được dọn khi ngắt (client không xoá được cả
  collection trong một lệnh). Rác tích trong Firestore, cần TTL policy nếu dùng lâu.

## Lưu ý

- `NUXT_PUBLIC_*` được nhúng vào bundle lúc build. Đổi env thì phải build lại.
- Firebase web config là public; kiểm soát truy cập nằm ở `storage.rules`.
  Rules mặc định chỉ cho user đã đăng nhập đọc/ghi `uploads/`, giới hạn 200 MB mỗi tệp.
- Chưa có Firebase Auth. Muốn chạy thật thì thêm auth, hoặc nới rules cho phù hợp
  với mô hình truy cập mong muốn.
- Bucket dùng chung với app khác trong project. `NUXT_PUBLIC_STORAGE_PREFIX` quyết
  định app này ghi vào thư mục nào — đổi nếu `uploads/` đã có người dùng.
- Nên giới hạn API key theo HTTP referrer (`ai-studio-client.web.app`,
  `ai-studio-client.firebaseapp.com`) ở Google Cloud Console → Credentials.

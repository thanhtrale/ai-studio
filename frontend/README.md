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

### Storage rules — KHÔNG deploy tự động

`storage.rules` cố ý **không** được khai trong `firebase.json`. Rules là phạm vi
**bucket, dùng chung cả project** — đẩy lên sẽ ghi đè rules của app khác đang dùng
`forward-camera-345608`. Muốn áp thì xem kỹ rules hiện có trên Console trước, rồi
chạy thủ công:

```bash
npx firebase-tools deploy --only storage --project forward-camera-345608
```

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

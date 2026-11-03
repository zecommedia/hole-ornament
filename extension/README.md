# Project-O Flow Bridge (extension)

Chạy pipeline tách design của Project-O qua **Google Flow (Nano Banana)** — dùng lại
đúng máy tự động hoá Flow của extension mẫu (`content.js` + service-worker + CDP),
chỉ thêm lớp **poll bridge HTTP** của app.

Luồng: app tạo job trong bridge (`/api/bridge/*`) → extension poll `/api/bridge/next`
→ mở/giữ tab Flow → upload ảnh + điền prompt + generate → lấy ảnh kết quả → POST về
`/api/bridge/result/:id`.

## Cài
1. Chrome → `chrome://extensions` → bật **Developer mode**.
2. **Load unpacked** → chọn thư mục `extension/` này.
3. **Details → Extension options**:
   - **Bridge base URL**: `http://localhost:4500` (local) hoặc `https://pj-oh.auto-agents.org` (tunnel).
   - **Bridge token**: chỉ điền nếu server đặt `BRIDGE_TOKEN`.
   - Tick **Bật polling** → Lưu.
4. Mở 1 tab `https://labs.google/fx/tools/flow` và **đăng nhập** tài khoản Flow. Để tab mở (nền cũng được — extension dùng `debugger` giữ tab không throttle).

## Chạy
Trong app Project-O: bật toggle **"Dùng Flow"** → upload ảnh mockup thô → **Tạo file in**.
App tạo job → extension chạy Flow → app nhận ảnh đã tách design → bạn đặt lỗ semi-auto.

## Cấu trúc
- `content.js` — driver Flow của mẫu (upload ảnh, chọn từ gallery, điền prompt, submit, chờ tile, lấy URL kết quả). **Giữ nguyên.**
- `service-worker.js` — SW của mẫu (CDP: gõ/click/nhập, download-intercept, quản lý tab) **+ lớp poll bridge** (`poPoll`/`poRunJob` ở cuối file) nối vào `/api/bridge/*` và chạy mỗi job như 1 Flow "upscale" (1 ảnh → 1 ảnh).
- `options.html/js` — URL bridge + token + bật/tắt.
- `sidepanel/`, `gemini.js`, `chatgpt.js` — của mẫu, giữ lại (không bắt buộc cho luồng bridge).

## ⚠️ Chưa test được tự động (cần Chrome + Flow thật)
- Nếu Flow đổi DOM, chỉnh selector trong `content.js` (mẫu vốn đã lo phần này khá kỹ).
- Lớp bridge chạy job kiểu **`upscale`** (1 ảnh + prompt). Nếu Flow cần đúng "image-to-image", có thể phải chỉnh `kind`/settings trong `poRunJob` (cuối `service-worker.js`).
- Soi log: `chrome://extensions` → **service worker** → Console → xem `[po-bridge]` và `[zps]`. Trong tab Flow: F12 → Console → `[zps ...]`.

Chạy thử 1 job rồi gửi mình log nếu cần tinh chỉnh.

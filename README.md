# Project-O · Hole Ornament Print Builder

Ứng dụng tạo file in ornament acrylic từ ảnh mockup sản phẩm: tách thiết kế bằng AI, tùy chọn thay tên và tạo mặt sau, dựng lớp CUT cùng lỗ treo, rồi ghép thành PNG để in.

## Luồng xử lý hiện tại

```text
Ảnh mockup
  → AI tách thiết kế trên nền trong suốt
  → Thay tên trên thiết kế (nếu nhập tên)
  → Tạo mặt sau với chữ được lật gương (nếu chọn 2 mặt)
  → Chuẩn hóa ảnh PNG
  → Dựng CUT và đặt lỗ treo bằng hình học
  → Ghép các panel, lật ngang toàn bộ file in
  → PNG file in + PNG lớp CUT + preview WebP
```

- Model của API tạo file in: `gpt-image-2` (mặc định) hoặc `gpt-image-2-c`. Có kiểm tra alpha và thử lại khi model không trả nền trong suốt thật.
- Một mặt: `[CUT][FRONT]`, canvas **3600 × 7200 px**. Hai mặt: `[CUT][BACK][FRONT]`, canvas **3600 × 10800 px**. File in ở **300 DPI**.
- Mặt sau được AI tạo từ mặt trước; giao diện không yêu cầu tải ảnh mặt sau riêng.
- Pipeline chính hiện không gọi RMBG, không cần Python, GPU hay tải model Hugging Face.

## Cài đặt và chạy

Cần Node.js **20 trở lên** theo `package.json`, npm và API key của nhà cung cấp được cấu hình. Chạy lệnh từ thư mục gốc project.

```powershell
npm install
Copy-Item .env.example .env
```

Nếu đã có `.env`, chỉnh file hiện có. Trong `.env`, đặt endpoint phù hợp với nhà cung cấp; mặc định trong mã là:

```dotenv
PORT=4500
DATA_DIR=data
V98_BASE_URL=https://cheapkeyai.shop/v1
```

**Lưu ý:** `.env.example` vẫn chứa endpoint v98store và cấu hình RMBG cũ. Cập nhật `V98_BASE_URL` khi sao chép; `RMBG_URL`, `HF_TOKEN` và `V98_VISION_MODEL` không cần cho pipeline chính hiện tại.

Chạy bản build:

```powershell
npm run build
npm start
```

Mở <http://localhost:4500>, nhập API key trên giao diện, tải mockup, chọn số mặt/kích thước rồi tạo file in. Key gửi trong từng request là bắt buộc; `/run` không dùng key trong `.env` để thay thế. Giao diện lưu key trong localStorage của trình duyệt.

Khi phát triển:

```powershell
npm run dev
```

Giao diện tại <http://localhost:5173>, API tại <http://localhost:4500>. Vite chuyển tiếp `/api` sang backend.

| Lệnh | Công dụng |
| --- | --- |
| `npm start` | Chạy backend và phục vụ giao diện đã build trong `ui/dist/` |
| `npm run dev` | Chạy backend và Vite với cập nhật giao diện khi sửa mã |
| `npm run build` | Build giao diện vào `ui/dist/` |
| `npm test` | Kiểm tra compositor bằng ảnh tổng hợp, không gọi AI |

`run-dev.bat` và `start-all-servers.bat` vẫn khởi động thêm RMBG Python cũ. `start-all-servers.bat` còn quản lý các project bên cạnh và tunnel; dùng các lệnh npm phía trên khi chỉ chạy ứng dụng này.

## Đặt lỗ và chỉnh màu

- `auto`: chọn lỗ trong thiết kế hoặc vòng treo theo hình dạng phần đỉnh; đây là heuristic, cần kiểm tra kết quả.
- `inside`: khoan lỗ trong thiết kế.
- `loop`: tạo vòng treo bên ngoài thiết kế.
- Chế độ semi-auto cho phép chỉnh vị trí và đường kính lỗ. Asset vòng treo nằm ở `assets/hole.png` hoặc đường dẫn `LOOP_ASSET`.
- Sau khi tạo xong, chỉnh lại lỗ/kích thước/màu bằng `/recompose` từ ảnh đã lưu, không gọi AI lại. Màu luôn áp từ bản gốc để tránh cộng dồn sau nhiều lần chỉnh.

## API

Các đường dẫn bên dưới có tiền tố `/api/ornament`.

| Phương thức | Đường dẫn | Công dụng |
| --- | --- | --- |
| GET | `/health` | Trạng thái và quota nhà cung cấp, dùng `V98_API_KEY` trong môi trường nếu có; không kiểm tra RMBG |
| GET | `/loop-asset` | Trả ảnh asset vòng treo |
| POST | `/upload?ext=png` | Nhận dữ liệu ảnh thô, tối đa 25 MB; trả `fileId` và URL |
| POST | `/run` | Bắt đầu job và trả ngay `{ ok, jobId, async: true, sides }` |
| GET | `/run-status/:jobId` | Đọc trạng thái `running`, `done`, `error`; kết quả nằm trong `result` |
| POST | `/recompose` | Ghép lại từ ảnh của job đã có, chỉnh lỗ và màu |
| GET | `/file/:jobId/:name` | Tải ảnh kết quả hoặc ảnh trung gian |

Ví dụ body JSON tối thiểu cho `/run` sau khi upload:

```json
{
  "frontFileId": "<fileId trả về từ upload>",
  "v98Key": "<API key của bạn>",
  "v98Model": "gpt-image-2",
  "sides": 1,
  "sizeInches": 3
}
```

Tùy chọn `/run`: `customName`, `manualHole`, `holeMode`, `holePosX`, `holePosY`, `holeDiaInch` (0.1–1.0", mặc định 0.25", áp dụng mọi chế độ), `cutOffsetInch` (viền cắt 0–0.25", mặc định 0.04"), `loopOverlap`, `trimLoop` (mặc định tắt). Tọa độ lỗ thủ công được áp dụng khi `manualHole: true`.

Trước khi dựng CUT, cutout AI được dọn lớp sương alpha < 32 và các đốm rời nhỏ (`cleanCutoutAlpha`) để CUT ôm đúng design và design không bị thu nhỏ/lệch tâm.

`/recompose` nhận `jobId`, `sides`, `sizeInches`, các tham số lỗ và tùy chọn `color: { sat, bright, contrast, temp }`. Điểm trung tính là `100, 100, 100, 0`.

Nếu đặt `AUTH_TOKEN`, các route `/api/*` yêu cầu header `X-Auth-Token`, ngoại trừ `/api/ornament/health`. Giao diện hiện chưa tự gửi header này; chỉ bật khi client hoặc proxy đã xử lý header. Bridge có thêm kiểm tra `X-Bridge-Token` ở các route dành cho extension khi đặt `BRIDGE_TOKEN`.

## Cấu trúc project

```text
server.js                 Express, static UI, auth và mount API
src/
  ornament-api.js         Upload, job AI bất đồng bộ, recompose và tải file
  bridge-api.js           Hàng đợi HTTP cho extension trình duyệt
  lib/
    v98-extract.js        Client AI, prompt, xử lý ảnh trả về và retry
    ornament-compose.js   Dựng CUT, lỗ treo, bố cục và xuất file in
    stroke.js             Xử lý đường viền
    color-match.js        Khớp màu ảnh AI với ảnh tham chiếu
    rate-limit.js         Giới hạn request theo IP
    logger.js             Ghi log
    rmbg.js               Bộ gọi PowerShell tách nền cũ; pipeline chính không import
ui/src/                   Giao diện React, thành phần chính HoleOrnament.jsx
assets/hole.png           Asset vòng treo
extension/                Extension Flow/Gemini/ChatGPT và side panel
tools/stroke.mjs          Công cụ thêm viền chạy thủ công
RMBG/                     Công cụ PowerShell tách nền và ảnh thử nghiệm
py-rmbg/                  Server RMBG-2.0 Python cũ và môi trường riêng
.hf-cache/                Cache model của server Python cũ
data/                     Upload và kết quả runtime
ui/dist/                  Giao diện đã build
test/compose-test.mjs     Smoke test compositor
```

Extension dùng hàng đợi riêng `/api/bridge/*`. Luồng `/api/ornament/run` hiện chỉ gọi nhà cung cấp AI trực tiếp, không đưa job vào bridge. README trong `extension/` còn mô tả toggle “Dùng Flow” của luồng cũ; giao diện chính hiện không có tích hợp đó.

## Công cụ chạy thủ công

Các script dưới đây chạy độc lập với giao diện; xem phần đầu mỗi file để biết tham số đầy đủ.

| Script | Công dụng |
| --- | --- |
| `build-ornament.mjs` | Ghép từ ba ảnh front/back/cut đã tách nền |
| `check-ornament.mjs` | Đo độ lấp đầy và chi tiết của file in |
| `enhance-ornament.mjs` | Tăng độ nét panel màu, giữ alpha và bỏ qua CUT |
| `flip-image.mjs` | Lật ảnh ngang hoặc dọc |
| `measure-extract.mjs` | So sánh cách gọi extract; có gọi AI và tốn quota |
| `tools/stroke.mjs` | Thêm đường viền cho panel in |

Ảnh mẫu, ảnh thử nghiệm ở thư mục gốc, `ornament-out/` và các thư mục QA dưới `RMBG/` phục vụ thao tác thủ công, không phải mã nguồn ứng dụng.

## Dữ liệu và kiểm tra

- Upload và ảnh job nằm trong `data/ornament/`; được dọn theo TTL 24 giờ khi có request kích hoạt dọn dữ liệu.
- Trạng thái job chạy lưu trong bộ nhớ, TTL một giờ; mất khi backend khởi động lại. Ảnh trên đĩa có thể vẫn còn sau khi mất trạng thái.
- `.env`, `node_modules/`, `data/`, `ui/dist/` và `test/_out/` được khai báo trong `.gitignore`.
- `npm test` kiểm tra canvas một/hai mặt và lỗ CUT ở chế độ inside/loop. Bài kiểm tra này không xác minh chất lượng ảnh AI hoặc hoạt động extension.

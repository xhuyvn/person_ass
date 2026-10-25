# PersonalAss — runbook local (Windows 11)

M0–M3: Expo Web + Fastify + SQLite; memo, việc, lịch, nhắc; AI xử lý memo (M2); ảnh + OCR (M3).

## Yêu cầu

| Thành phần | Phiên bản | Ghi chú |
| --- | --- | --- |
| Node.js | 24.x LTS (>=24.0.0) | `node:sqlite` cần Node >= 22; repo pin `engines.node >=24.0.0` |
| npm | 11.x | dùng workspaces, một lockfile ở gốc |
| PowerShell | 5.1 hoặc 7+ | script `scripts/*.ps1` |
| Trình duyệt | Chrome/Edge hiện đại | web build phục vụ qua HTTP |

Không cần Docker, không cần Ollama, không cần API key ở M0.

## Cài đặt lần đầu

```powershell
cd D:\Cldwork\coder
npm install --no-audit --no-fund
Copy-Item .env.example .env      # chỉ placeholder, sửa sau nếu cần
```

## Chạy

```powershell
.\scripts\start-local.ps1        # migrate + build server + start backend, chờ /health/ready
npm run web --workspace apps/client   # terminal thứ hai: Expo web dev server (http://127.0.0.1:2311)
```

Dừng:

```powershell
.\scripts\stop-local.ps1
```

Địa chỉ:

| Thành phần | URL |
| --- | --- |
| API | http://127.0.0.1:2310 |
| Health live | http://127.0.0.1:2310/health/live |
| Health ready | http://127.0.0.1:2310/health/ready |
| Web dev (Expo) | http://127.0.0.1:2311 |

Port mặc định: backend **2310**, web dev **2311** (`npm run web` đã gắn `--port 2311`). `APP_ORIGIN` mặc định cho phép cả `http://127.0.0.1:2311` và `http://localhost:2311` vì Expo thường mở `localhost`.

Trang web đọc `EXPO_PUBLIC_API_BASE_URL` (mặc định `http://127.0.0.1:2310`). Lưu ý: Expo đọc biến `EXPO_PUBLIC_*` từ `apps/client/.env`, không phải `.env` ở gốc repo; chỉ cần đặt khi backend không ở 2310. Khi web chạy ở origin khác (ví dụ bản build tĩnh phục vụ ở port khác), origin đó phải nằm trong `APP_ORIGIN` của backend, nếu không trình duyệt bị CORS chặn và mọi thao tác ghi bị từ chối (403).

## Các lệnh kiểm tra

| Lệnh | Ý nghĩa |
| --- | --- |
| `npm run typecheck` | TypeScript strict cho cả 4 workspace |
| `npm run test` | vitest: contracts, server (migrate + API), client |
| `npm run build:server` | emit `apps/server/dist` |
| `npm run build:web` | export web tĩnh vào `apps/client/dist` |
| `npm run migrate` | chạy migration còn thiếu (idempotent) |

Migration không bao giờ xoá dữ liệu: chạy lại trên DB đã có schema là no-op.

## Dữ liệu

`DATA_DIR` (mặc định `./.data`, resolve theo repo root):

```
.data/
  database/personalass.sqlite   (+ sidecar WAL)
  attachments/original
  attachments/derived
  backups/
  logs/
  secrets/
```

Muốn dùng thư mục khác: đặt `DATA_DIR` trong `.env` hoặc biến môi trường (đường dẫn tuyệt đối được giữ nguyên).

## Biến môi trường

Xem `.env.example` (theo docs/06 §4). Không đặt secret vào `EXPO_PUBLIC_*` (biến này được nội tuyến vào bundle web).

### Master key (M2)

API key của provider được mã hóa AES-256-GCM bằng master key nằm **ngoài** database:

- `MASTER_KEY` (32 byte, base64 hoặc hex) nếu đặt sẽ được dùng trước.
- Nếu không, dùng file `MASTER_KEY_FILE` (mặc định `DATA_DIR/secrets/master.key`). Ở `APP_MODE=local`, lần chạy đầu tự sinh file này (quyền chỉ chủ sở hữu, log `master_key_loaded` với `created: true`). `APP_MODE=server` không bao giờ tự sinh: thiếu file là dừng khởi động.
- **Sao lưu master key riêng**, không để chung với backup dữ liệu. Mất master key thì phải nhập lại API key cho từng kết nối; không có cách giải mã giả.
- Nếu master key lỗi ở local mode, app vẫn chạy (log `master_key_unavailable`) nhưng không lưu/dùng được API key.

## Cấu hình AI (M2)

Trên web: trang chính → **Cài đặt AI** (`/settings`): thêm kết nối, Test / Test text, Tải model hoặc nhập model id, gán vai trò “Xử lý thông tin” và dự phòng. Tương đương qua API:

```powershell
# 1) Thêm kết nối (key chỉ gửi khi ghi; GET không bao giờ trả key)
curl.exe -X POST http://127.0.0.1:2310/api/v1/ai/connections -H "content-type: application/json" -d "{\"name\":\"Ollama\",\"kind\":\"ollama_local\",\"base_url\":\"http://127.0.0.1:11434/v1\",\"privacy_scope\":\"local\"}"
# 2) Test (không lưu gì): metadata = GET /models, text = một câu chat ngắn
curl.exe -X POST http://127.0.0.1:2310/api/v1/ai/connections/<id>/test -H "content-type: application/json" -d "{\"kind\":\"text\",\"model_id\":\"<model>\"}"
# 3) Gán model cho vai trò information
curl.exe -X PUT http://127.0.0.1:2310/api/v1/ai/roles -H "content-type: application/json" -d "{\"roles\":[{\"role\":\"information\",\"connection_id\":\"<id>\",\"model_id\":\"<model>\"}]}"
```

- OpenRouter/Ollama Cloud bắt buộc https. http chỉ cho địa chỉ loopback/LAN (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7); địa chỉ link-local/metadata luôn bị chặn; không đi theo redirect.
- `privacy_scope` do bạn khai báo: memo `privacy: "local_only"` chỉ được gửi tới kết nối `local`. Fallback từ local sang cloud chỉ khi `allow_cloud: true`.
- Memo lưu trước, job xử lý sau. Không có cấu hình hoặc key sai → job `waiting_configuration`, tự chạy lại khi sửa kết nối/role. Provider offline/429 → `retry_wait` (tối đa 3 lần). Xem `GET /api/v1/jobs/:id`.
- Trang chính: ô “Để AI tạo việc/lịch/ghi chú từ memo” (mặc định bật) và “Chỉ xử lý cục bộ”. Mục **Memo gần đây** hiện trạng thái job, mục AI đã áp dụng (nút Hoàn tác), câu hỏi làm rõ (Lưu / Áp dụng / Xác nhận / Bỏ qua) và nút Xử lý lại.

## Ảnh và OCR (M3)

- Trang chính → **Thêm ảnh** (hoặc dán Ctrl+V / kéo thả): JPEG, PNG, WebP; mặc định tối đa 10 ảnh/memo, 10 MB/ảnh, 40 megapixel. Đổi bằng `MAX_IMAGES_PER_MEMO`, `MAX_UPLOAD_BYTES`, `MAX_IMAGE_PIXELS` trong `.env`.
- Ảnh gốc lưu ở `DATA_DIR/attachments/original` (tên UUID), bản gửi AI (JPEG thu nhỏ, đã bỏ EXIF) ở `attachments/derived`. Sao lưu cả thư mục `attachments` cùng database.
- Cần gán vai trò **Đọc chữ trong ảnh (OCR)** trong Cài đặt AI cho một model đọc được ảnh, rồi bấm **Test ảnh**. Chưa gán → memo vẫn lưu, job `waiting_configuration`; model chỉ đọc text → `no_image_input`.
- Chỗ OCR đọc chưa chắc được đánh dấu "⚠ chưa chắc"; khi ảnh còn chỗ nghi vấn, app hỏi lại mọi ngày/giờ thay vì tự tạo lịch. Bấm **Sửa chữ** để sửa → app tự xử lý lại với chữ đã sửa (không gọi OCR lại).
- API: `POST /api/v1/attachments` (multipart field `file`) → `attachment_token`; `POST /api/v1/memos` với `attachment_tokens`; `POST /api/v1/attachments/:id/ocr-corrections`; `GET /api/v1/sources?entity_type=&entity_id=`.

## Cấu trúc repo

```
apps/client      Expo SDK 58 + expo-router (web trước, native sau)
apps/server      Fastify 5 + node:sqlite
packages/contracts  Zod schema dùng chung (client + server)
packages/ui      theme RN light/dark
migrations/      SQL có phiên bản
scripts/         start-local.ps1, stop-local.ps1
docs/            đặc tả thiết kế (không sửa khi code)
```

## Định tuyến phụ thuộc

`packages/contracts` không import server/SQLite/UI. `apps/server` không import React. `packages/ui` không import server.

## Điều chưa có

Chưa có people/project/search (M4), launcher + backup (M5), auth (M6), Docker (M6). Xem `IMPLEMENTATION-STATUS.md` và `docs/07-IMPLEMENTATION-ACCEPTANCE.md`.

# PersonalAss — runbook local (Windows 11)

M0 (nền): Expo Web + Fastify + shared contracts + SQLite migration. Chưa có AI, chưa có ghi dữ liệu nghiệp vụ.

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
npm run web --workspace apps/client   # terminal thứ hai: Expo web dev server (http://127.0.0.1:8081)
```

Dừng:

```powershell
.\scripts\stop-local.ps1
```

Địa chỉ:

| Thành phần | URL |
| --- | --- |
| API | http://127.0.0.1:4310 |
| Health live | http://127.0.0.1:4310/health/live |
| Health ready | http://127.0.0.1:4310/health/ready |
| Web dev (Expo) | http://127.0.0.1:8081 |

Trang web đọc `EXPO_PUBLIC_API_BASE_URL` (mặc định `http://127.0.0.1:4310`). Khi web chạy ở origin khác (ví dụ bản build tĩnh phục vụ ở port khác), origin đó phải nằm trong `APP_ORIGIN` của backend, nếu không trình duyệt sẽ bị CORS chặn.

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

Xem `.env.example` (theo docs/06 §4). `APP_MODE=server` chưa dùng ở M0; `MASTER_KEY`/`MASTER_KEY_FILE` chỉ là placeholder cho M2/M6. Không đặt secret vào `EXPO_PUBLIC_*` (biến này được nội tuyến vào bundle web).

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

## Điều chưa có ở M0

Không có AI/provider, không có ghi memo/task, không có scheduler, không có notification, không có auth, không có upload ảnh, không có Docker. Xem `IMPLEMENTATION-STATUS.md` và `docs/07-IMPLEMENTATION-ACCEPTANCE.md`.

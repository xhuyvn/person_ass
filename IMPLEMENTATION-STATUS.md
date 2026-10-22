# Trạng thái triển khai

Ngày bàn giao thiết kế: 21/10/2026. M0 triển khai xong ngày 22/10/2026.

| Mốc | Trạng thái | Bằng chứng |
| --- | --- | --- |
| M0 Nền | **Đã làm, đã kiểm tra** | 57 test vitest pass; typecheck/build server/build web pass; migrate idempotent; web gọi health thật qua trình duyệt |
| M1 Manual slice | Chưa bắt đầu | — |
| M2–M6 | Chưa bắt đầu | — |

Coder cập nhật file này sau mỗi milestone. Giữ test/benchmark chưa chạy ở trạng thái chưa xác minh.

---

## M0 — Nền (22/10/2026)

### 1. Đã làm

| Hạng mục | Nội dung |
| --- | --- |
| Repo | npm workspaces (root lockfile duy nhất): `apps/client`, `apps/server`, `packages/contracts`, `packages/ui`, `migrations/`, `scripts/` |
| Backend | Fastify 5 + TypeScript strict (ESM). `GET /health/live`, `GET /health/ready`. Error envelope `{error:{code,message,field_errors?,retryable,correlation_id}}` theo docs/03 §4. `x-correlation-id` được sinh/sanitize và trả về. CORS theo allowlist `APP_ORIGIN` (không bao giờ `*`). Logger JSON có redact key/token/secret/password/authorization |
| Shared contracts | `packages/contracts`: Zod 4 — `ApiErrorCode` + map status, `apiErrorSchema`, `healthLiveSchema`, `healthReadySchema`, `paginationSchema`, DTO stub memo/task/appointment. Không import server/SQLite/UI |
| Web client | Expo SDK 58 + expo-router, react-native-web, RN primitives. Màn "Trạng thái" gọi `/health/ready` (timeout 5 s, validate bằng `healthReadySchema`), nút "Thử lại", màn "Giới thiệu". Theme light/dark ở `packages/ui` |
| SQLite | `node:sqlite` (built-in, Node ≥ 24). WAL + `foreign_keys=ON` + `busy_timeout=5000`. Migration runner có phiên bản, mỗi file một transaction, idempotent, không bao giờ DROP/DELETE |
| Migration | `migrations/0001_core.sql` (15 bảng: settings, areas, categories, people, projects, memos, memo_revisions, tasks, appointments, reminder_rules, source_links, entity_links, action_groups, audit_events, request_idempotency) + `migrations/0002_core_indexes.sql`. FK/CHECK/UNIQUE có thật; `due_date`/`due_at` loại trừ nhau; appointment timed↔all_day |
| Scripts | `scripts/start-local.ps1` (migrate → build → start → chờ readiness → lock file PID/port, chặn instance thứ hai), `scripts/stop-local.ps1` (dừng cây tiến trình, xoá lock) |
| Tài liệu | `.env.example` đúng contract docs/06 §4 (chỉ placeholder); `RUNBOOK.md` hướng dẫn chạy Windows 11 |
| Test | vitest 5.0.5: contracts 22, server 28 (migrate + API), client 7 — **tổng 57 pass / 0 fail** |

### 2. Lệnh kiểm tra đã chạy và kết quả

| Lệnh | Kết quả |
| --- | --- |
| `npm install --no-audit --no-fund` | OK — lockfile gốc duy nhất, không có lockfile lồng |
| `npm run typecheck` | PASS (client, server, contracts, ui — 0 lỗi, TS 6.0.3) |
| `npm run test` | PASS — 57/57 (contracts 22, server 28, client 7) |
| `npm run build:server` | PASS — `apps/server/dist/index.js` |
| `npm run build:web` | PASS — `apps/client/dist/index.html` (6 web bundles) |
| `npm run migrate` (DB rỗng mới) | `{"applied":2,"version":2}` |
| `npm run migrate` (lần 2) | `{"applied":0,"version":2}` — no-op, dữ liệu cũ giữ nguyên |
| `npm run migrate` (2 lần, DATA_DIR tạm) | lần 1 `applied:2`, lần 2 `applied:0` |
| `node apps/server/dist/index.js` + curl | `/health/live` 200, `/health/ready` 200 `{"status":"ok","migrations_applied":2}`, route lạ → 404 envelope `NOT_FOUND`, Origin lạ → không có `access-control-allow-origin` |
| E2E trình duyệt (build web tĩnh ở :4300, backend ở :4310, `APP_ORIGIN` khai báo đúng origin) | Trang hiện "Trạng thái: ok", "Số migration đã áp dụng: 2", "Cơ sở dữ liệu: OK", "Thư mục dữ liệu: OK"; 0 cảnh báo trong console |
| `scripts\start-local.ps1` / `stop-local.ps1` | Chạy thật: backend ready HTTP 200, chặn instance thứ hai, stop dừng đúng cây tiến trình và xoá lock file |

### 3. Migration note

- Schema version hiện tại: **2** (`schema_migrations`).
- Migration chỉ ADDITIVE, có `IF NOT EXISTS`, chạy trong transaction, đã apply thì không chạy lại. **Không reset DB người dùng để chữa lỗi.**
- `memos.current_revision_id` chưa có FK tới `memo_revisions` (tránh vòng FK); sẽ thêm bằng migration sau khi có đường ghi thực tế.

### 4. Test bỏ qua / chưa xác minh

| Mục | Lý do |
| --- | --- |
| Test native iOS/Android | M0 chỉ nghiệm thu web (docs/07: "Không cần native app build để nghiệm thu MVP 1") |
| OpenAPI sinh từ Zod | Chưa có route nghiệp vụ; sẽ sinh ở M1 |
| Smoke provider thật (OpenRouter/Ollama) | Chưa có lớp AI (M2), không dùng key trong M0 |
| Benchmark p95 | Cần dữ liệu 10.000 đối tượng (M4/M5) |
| Test trên Node 22 LTS | Repo pin Node ≥ 24 vì `node:sqlite` |

### 5. Known limitations (M0)

1. Chưa có AI, worker, scheduler, notification, auth, upload ảnh, ghi memo/task — đúng phạm vi M0.
2. `apps/server/src/app.ts` hook `onError` ghi `status_code` trước khi error handler đổi status → log ghi 200 thay vì 400/404/413/500. Chỉ ảnh hưởng log phía server, **không** ảnh hưởng response (đã có test).
3. `GET /health/ready` đưa message lỗi filesystem thô vào `checks.data_dir.detail` (chỉ thông tin local path, không có secret).
4. `node:sqlite` yêu cầu Node ≥ 24 (repo pin `engines.node >=24.0.0`); không dùng `better-sqlite3` để tránh biên dịch native trên Windows. Nếu cần hỗ trợ Node 22 phải đổi driver qua một adapter mỏng.
5. `npx expo install --check` sạch sau khi thống nhất TypeScript **6.0.3** cho toàn repo (bỏ `baseUrl` đã deprecated). Một số dependency Expo phải theo `bundledNativeModules.json` của SDK 58, đã ghi ở mục 6.
6. Expo CLI tự ghi lại `apps/client/tsconfig.json` (`include`) ở lần `expo start`/`expo export` đầu tiên — file đã ở dạng chuẩn của Expo sau đó.
7. Origin của web phải nằm trong `APP_ORIGIN` của backend, nếu không trình duyệt bị CORS chặn (đã kiểm chứng bằng E2E).
8. `scripts/start-local.ps1` để tiến trình chạy nền; `stop-local.ps1` dừng theo cây PID ghi trong `.data/local.lock.json`.
9. Repo **chưa phải git repository** — không có commit nào được tạo (chưa được phép `git init` trong phiên này).
10. Chưa có Docker/Compose, backup/restore CLI, launcher Windows — thuộc M5/M6.

### 6. Version compatibility (đã kiểm tra 22/10/2026)

| Nhóm | Phiên bản | Nguồn kiểm tra |
| --- | --- | --- |
| Expo SDK | expo 58.0.17, expo-router 58.0.25, expo-constants 58.0.13, expo-linking 58.0.14, expo-status-bar 58.0.4, expo-system-ui 58.0.6, expo-splash-screen 58.0.11, expo-font 58.0.9, expo-asset 58.0.18, @expo/metro-runtime 58.0.15, @expo/vector-icons 15.0.2, @expo/ui 58.0.22, expo-symbols 58.0.4 | `node_modules/expo/bundledNativeModules.json` (sdk-58) |
| React Native | react 19.3.0, react-dom 19.3.0, react-native 0.88.0, react-native-web 0.21.4, screens 4.30.0, safe-area-context 5.10.1, gesture-handler 3.3.0, reanimated 4.7.1, worklets 0.13.0 | bundledNativeModules + `create-expo-app` template SDK 58 |
| Server | fastify 5.12.7, @fastify/cors 11.0.1, zod 4.6.7 | npm registry (latest ở thời điểm kiểm tra) |
| Tooling | typescript 6.0.3 (một version cho toàn repo), @types/node 24.19.2, @types/react 19.3.0, tsx 4.23.15, vitest 5.0.5 | Expo SDK 58 yêu cầu TS ~6.0.3; `expo install --check` = up to date |
| Runtime | Node 24.15.0 (LTS), npm 11.12.1 | máy dev |

Tất cả dependency trong `package.json` của từng workspace được pin **version chính xác** (không `^`/`~`); lockfile ở gốc là nguồn cài đặt duy nhất.

### 7. Bước tiếp theo (M1 — Manual slice)

Chưa bắt đầu. Theo docs/07, M1 cần: tạo memo → task → reminder → notification trong app; restart xong nhắc vẫn còn; idempotency/version pass. Cần thêm các bảng còn thiếu (`notes`, `notifications`, `delivery_attempts`, `occurrences`, `attachments`, `jobs`, `recurrence_series`, …) bằng migration mới (chỉ ADDITIVE), các route `/api/v1/*` theo docs/03 §4, và sinh OpenAPI từ Zod.

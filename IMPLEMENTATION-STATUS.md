# Trạng thái triển khai

Ngày bàn giao thiết kế: 21/10/2026. M0 triển khai xong ngày 22/10/2026. M1 bắt đầu 23/10/2026.

> Rà soát M0 (23/10/2026): `npm ci` sạch, typecheck PASS, test PASS (số test thực tế cao hơn con số 57 ghi bên dưới: contracts 24, server 60→86 sau M1, client 10). Mục 5.9 "chưa là git repository" đã lỗi thời. Chưa chạy lại E2E trình duyệt và `start-local.ps1` trong lần rà soát này.

| Mốc | Trạng thái | Bằng chứng |
| --- | --- | --- |
| M0 Nền | **Đã làm, đã kiểm tra** | 57 test vitest pass; typecheck/build server/build web pass; migrate idempotent; web gọi health thật qua trình duyệt |
| M1 Manual slice | **Đã làm, đã kiểm tra (web)** | 126 test pass (contracts 24, server 86, client 16); E2E trình duyệt: memo → việc có nguồn → lịch hẹn → nhắc thật → restart backend → nhắc còn → ack/hoàn thành |
| M2 AI text | **Backend + UI web đã làm, đã kiểm tra bằng mock; chưa smoke provider thật** | 163 test pass (contracts 24, server 117, client 22); E2E trình duyệt với endpoint OpenAI-compatible giả lập: cài đặt → memo → làm rõ → hoàn tác → chờ cấu hình → tự xử lý lại. Smoke OpenRouter/Ollama thật cần key của chủ sở hữu |
| M3–M6 | Chưa bắt đầu | — |

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


---

## M1 — Manual slice (23/10/2026)

### Đã làm
- Migration `0003_m1_manual.sql` (additive): `notes`, `occurrences`, `notifications`, `delivery_attempts`. Schema version = 3.
- Contracts Zod (`packages/contracts/src/m1.ts`) dùng chung cho validate runtime và OpenAPI.
- API `/api/v1`: memos (POST/GET, `client_request_id` UNIQUE suốt vòng đời), tasks (CRUD + complete/reopen), notes, appointments, reminder-rules, notifications (list/ack/snooze), `POST /entities/:type/:id/archive` (cần `confirm:true`), `GET /api/v1/openapi.json` (OpenAPI 3.1 sinh từ Zod).
- `Idempotency-Key` + request_hash (khác body → 409); PATCH/complete/archive dùng `expected_version` trong `WHERE ... AND version=?` (409 khi lệch).
- Nhắc mặc định (docs/00 B): hạn ngày → 09:00 local cùng ngày; lịch có giờ → trước 30 phút; task không hạn → không có nhắc. Sửa hạn/giờ tăng `schedule_revision`, hủy occurrence cũ và tạo mới trong cùng transaction; complete/archive/cancel hủy nhắc tương lai.
- Scheduler (tick 15 s, chạy ngay lúc khởi động): claim + tạo notification + đổi trạng thái occurrence trong một transaction; UNIQUE(occurrence_id, channel); trễ > 10 phút → gom một digest, occurrence đánh `missed`, không xóa. Clock được inject.
- Source link thủ công (memo revision + quote) và audit event cho mọi thay đổi.

### Lệnh kiểm tra
| Lệnh | Kết quả |
| --- | --- |
| `npm ci` | OK |
| `npm run typecheck` | PASS |
| `npm test` | PASS — contracts 24, server 86 (có 26 test M1 mới), client 10 |
| `npm run build:server` | PASS |

Acceptance đã có test tự động: A01, A02 (nhắc 08:30), A07, A13 (digest), A16 mức M1 (complete lặp), A18, A26/restart (notification còn sau khi mở lại DB), A31. Test trước đây giả định đúng 2 migration đã cập nhật lên 3.

### UI web (apps/client)
- Màn chính `/` (`src/components/Home.tsx`): ghi nhanh memo, việc (thêm/xong/mở lại, tùy chọn gắn nguồn từ memo vừa lưu), lịch hẹn, ghi chú, danh sách thông báo (Đã xem / Hoãn 30 phút), poll thông báo mỗi 15 s, banner khi mất kết nối. Màn trạng thái cũ chuyển sang `/status`.
- `src/lib/api.ts`: client có kiểm tra response bằng Zod, `Idempotency-Key` cho thao tác tạo, memo dùng `client_request_id` giữ nguyên khi retry. `src/lib/format.ts`: ngày dd/mm/yyyy, múi giờ Asia/Ho_Chi_Minh (offset +07:00 cố định).
- Lưu ý kỹ thuật: Metro không resolve được `./m1.js` nên schema M1 nằm trong `packages/contracts/src/index.ts` (không tách file có đuôi `.js`).

### E2E trình duyệt (build web tĩnh :4300 + backend build :4310, DB mới)
| Bước | Kết quả |
| --- | --- |
| Tạo lịch hẹn 15:54 qua form | Hiện trong danh sách; scheduler tạo thông báo lúc 15:24 (đúng -30 phút), trong ~11 s sau giờ hẹn nhắc |
| Lưu memo, tạo việc hạn 24/10 gắn nguồn | `GET /memos` trả `sources` trỏ đúng task + quote |
| Dừng và chạy lại backend (`migrations_applied: 0`) | Reload trang: thông báo vẫn còn, không bị tạo lại |
| Bấm "Đã xem", "Xong" | Thông báo chuyển "đã xem", việc "đã xong"; 0 lỗi ứng dụng |
| Console | Chỉ một `ERR_CONNECTION_REFUSED` do poll trong lúc backend đang tắt (đúng kỳ vọng) |

### Chưa làm / hạn chế
1. Chưa kiểm thử bằng trình duyệt: Hoãn 30 phút, banner offline, tạo ghi chú, mở lại việc, giao diện dark/mobile (các luồng này chỉ có test tự động ở API hoặc chưa có).
2. Chưa chạy `scripts\start-local.ps1` với M1; E2E dùng lệnh `node` trực tiếp.
3. Form lịch hẹn nhập giờ dạng chữ `yyyy-mm-dd hh:mm`; chưa có date picker, chưa hỗ trợ lịch cả ngày trên UI (API có).
4. Chưa làm: recurrence, attachments/jobs (M2–M3), `GET /today`, `/timeline`, `/search`, `/audit-events`, `GET/PATCH /settings`, action-groups/undo, `POST /memos/:id/revisions`, sửa/archive từ UI.
5. `memos.current_revision_id` chưa có FK; chưa có integrity scan cho link đa hình.
6. Chưa có thông báo OS của trình duyệt.
7. Mọi thay đổi chưa commit.

### Bước tiếp theo
Dọn các hạn chế 1–3 nếu muốn đóng M1 chặt hơn, rồi sang M2 (AI text: connections, adapters, proposals/policy).

---

## M2 — AI text, phần backend (25/10/2026)

Phạm vi phiên này (chủ sản phẩm chọn): sửa lỗ hổng Origin cho mutation, rồi làm backend M2. UI M2 (màn cấu hình AI, hiển thị kết quả/làm rõ/hoàn tác) là bước kế tiếp.

### Đã làm
- **Chặn mutation từ website lạ** (`app.ts`): POST/PATCH/PUT/DELETE có header `Origin` không thuộc `APP_ORIGIN` và không cùng origin với server → 403 trước khi vào route. Request không có Origin (curl, tiến trình local) vẫn được nhận. Chưa có CSRF token/bootstrap session đầy đủ như docs/06 §1 (để M5).
- **Migration `0004_m2_ai.sql`** (additive, schema version 4): `memos.privacy`, `ai_connections`, `ai_role_bindings`, `jobs` (lease + fencing_token), `ai_runs`, `proposals`, `proposal_actions` (unique partial index `(memo_revision_id, stable_key) WHERE status='applied'`), `clarifications`.
- **Master key** (`secrets/master-key.ts`): AES-256-GCM, AAD = id kết nối. `MASTER_KEY` hoặc `MASTER_KEY_FILE` (mặc định `DATA_DIR/secrets/master.key`; local mode tự sinh một lần với flag `wx`; server mode không bao giờ tự sinh).
- **Chính sách endpoint** (`ai/net-policy.ts`): chỉ http/https; OpenRouter/Ollama Cloud bắt buộc https; http chỉ tới loopback/mạng riêng; chặn link-local/metadata/multicast; kiểm IP **lúc kết nối** (lookup tùy biến, chống DNS rebinding); allowlist host:port theo kết nối; không đi theo redirect; timeout cứng; giới hạn 8 MB phản hồi. Đổi host của kết nối đã có key bắt buộc nhập lại key.
- **Adapter OpenAI-compatible** (`ai/openai-compatible.ts`): `/models` (capability lấy từ metadata nếu provider có, còn lại `unknown`), `/chat/completions`; `structured_output=auto` thử `json_schema` rồi bỏ `response_format` nếu endpoint trả 400/422; placeholder key `ollama` cho Ollama local; phân loại lỗi 401/403→auth, 404→model_not_found, 429 (Retry-After)→rate_limited, 5xx/mạng→unavailable, timeout; thông điệp lỗi đã che key.
- **API**: `GET/POST/PATCH /ai/connections`, `POST /ai/connections/:id/test` (metadata/text, không lưu), `GET /ai/connections/:id/models` (lỗi → `items: []`, `manual_allowed: true`), `GET/PUT /ai/roles` (fallback có `allow_cloud`), `GET /jobs/:id`, `POST /memos/:id/reprocess` (202), `GET /clarifications`, `POST /clarifications/:id/answer`, `POST /action-groups/:id/undo`, `GET /audit-events`. `POST /memos` nhận `process` (mặc định true) và `privacy`; receipt có `job_id`, `state: queued`. `GET /memos/:id` thêm `privacy`, `job`, `actions`, `clarifications`. OpenAPI sinh từ cùng schema Zod.
- **Worker** (`jobs/worker.ts`): job tạo trong cùng transaction với memo; claim có điều kiện + tăng fencing token; heartbeat 15 s, lease 90 s; không giữ transaction khi gọi LLM; concurrency 1; được đánh thức ngay khi có job mới, poll 2 s. 429/5xx/mạng → `retry_wait` backoff mũ + jitter, tôn trọng Retry-After, tối đa 3 lần → `failed`; 401/403/404/thiếu cấu hình → `waiting_configuration` (tự xếp lại khi sửa kết nối/role). Lease hết hạn ở lần thử cuối → `failed` (`lease_expired`). Fallback theo thứ tự; memo `local_only` không bao giờ tới kết nối `cloud`; local → cloud chỉ khi `allow_cloud`.
- **Prompt** (`ai/prompt.ts`): seed `prompts/information-system.txt` + hướng dẫn trường + JSON Schema; `prompt_version = information@<sha256 12 ký tự>`. Context gồm captured_at kèm thứ trong tuần theo múi giờ, defaults, tối đa 30 lịch hẹn + 30 task ứng viên (query, không gửi cả DB). Memo được rào `<<<MEMO … MEMO>>>` và ghi rõ là dữ liệu chưa tin cậy.
- **Proposal → policy → apply** (`domain/proposals.ts`): parse + validate envelope strict (chỉ gỡ một lớp code fence, không vá JSON), sửa tối đa một lần. Mỗi action: evidence phải khớp nguyên văn memo; `stable_key` do backend tính; trùng key đã áp dụng → `duplicate`; trùng tiêu đề trong cùng memo → hỏi xác nhận. Policy docs/04 §4: tạo task/note/lịch rõ → áp dụng; ambiguity/thiếu giờ → `missing_fields`; update một target rõ, đúng version → áp dụng + reschedule + undo; nhiều target → `choose_target`; target đã bị sửa → `revalidate`; đổi trạng thái (hủy/xong/lưu trữ) và `request_confirmation` → `confirm`; person/asset/interaction/maintenance → `rejected` (`entity_type_not_supported_yet`, làm ở M4). Toàn bộ apply + source link + reminder + audit (actor `ai`, `action_group_id`) + job succeeded nằm trong **một** transaction, mỗi action trong savepoint, kiểm fencing token ở cuối.
- **Trả lời làm rõ**: revalidate rồi áp dụng trên version hiện tại, tạo action group riêng (actor `user`, source `ai_clarification`), hoàn tác được.
- **Undo**: chỉ khi mọi entity còn đúng version nhóm để lại; nếu đã sửa tay → 409, `field_errors` liệt kê trường lệch, không hoàn tác một phần. Tạo → archive (hủy nhắc); sửa → khôi phục trường trước (nhắc được lập lại).
- (Đã thay bằng UI M2 bên dưới: client không còn gửi `process: false`.)

### Lệnh kiểm tra
| Lệnh | Kết quả |
| --- | --- |
| `npm ci` | OK |
| `npm run typecheck` | PASS (client, server, contracts, ui) |
| `npm test` | PASS — contracts 24, server 117 (31 test M2 mới trong `test/m2.test.ts`), client 16 |
| `npm run build:server` | PASS |
| Smoke: `node apps/server/dist/index.js` (DATA_DIR tạm, port 4398) + server OpenAI-compatible giả lập ở 127.0.0.1:4399 | master key file tự sinh; tạo kết nối `ollama_local` có key; test metadata OK; gán role; POST memo → worker được đánh thức → job `succeeded` trong < 2 s, task được tạo; chuỗi key không xuất hiện trong file SQLite và log |

Acceptance có test tự động (provider giả lập): A01, A02 (08:30), A03/A05 (fixture: task áp dụng, lịch khám thành clarification, không có appointment chính thức), A07, A08 (reprocess cùng output → `duplicate`, không thêm task/audit), A09 (JSON sai/operation lạ → sửa 1 lần → lỗi rõ, memo còn), A10, A11 (dời lịch, hủy nhắc cũ, tạo nhắc mới, undo), A12, A17, A18, A19 (offline → retry_wait, scheduler vẫn tạo thông báo), A20, A27 (key không có trong response/audit/DB/log), A28 (Origin lạ cho mutation), A30 (mức prompt: captured_at kèm thứ được gửi cho model), A32 (fencing).

### Test bỏ qua / chưa xác minh
| Mục | Lý do |
| --- | --- |
| Smoke OpenRouter + Ollama thật (A21, điều kiện qua M2) | Cần API key/endpoint thật của chủ sở hữu; chưa chạy. Làm theo RUNBOOK mục "Cấu hình AI" |
| Chất lượng trích xuất của model thật (A02 "mai", A04, A30 end-to-end) | Test dùng proposal viết sẵn; chỉ kiểm backend xử lý đúng proposal, không kiểm model hiểu đúng tiếng Việt |
| `policyTransport` tới host public qua https | Test mạng thật chỉ chạy trên loopback; https dùng cùng code path nhưng chưa có test mạng ngoài |

### Hạn chế đã biết
1. (Đã có UI M2, xem mục bên dưới.)
2. A04 (waiting on person) và person/asset chưa hỗ trợ — action bị `rejected` có lý do, chờ M4.
3. Ngân sách mỗi memo mới giới hạn số lần gọi (3 attempt × (1 + 1 repair) × số target fallback); chưa giới hạn token riêng.
4. `ENABLE_DEBUG_AI` chưa có tác dụng: không lưu raw request/response (đúng mặc định docs/04 §6).
5. Kiểm Origin mới là lớp chống CSRF đầu tiên; token CSRF/bootstrap session local và kiểm `Content-Type` để M5.
6. Nhiều ambiguity của cùng một action được gộp thành một câu hỏi.
7. Undo nhóm sửa task chỉ khôi phục title/description/hạn/planned_at/status.
8. Ứng viên gửi cho model là 30 lịch hẹn sắp tới + 30 task mở gần nhất, chưa lọc theo nội dung (search ở M4).

### Bước tiếp theo
1. (Xong: UI M2, xem mục bên dưới.)
2. Chủ sở hữu chạy smoke thật với OpenRouter và Ollama (A21), ghi kết quả vào đây.
3. Sau đó M3 (ảnh/OCR).

---

## M2 — UI web (25/10/2026)

### Đã làm
- **`/settings` — Cài đặt AI** (`src/components/AiSettings.tsx`): danh sách kết nối (loại, URL, phạm vi, key chỉ hiện dạng `…abcd`), Test metadata, Test text với model id, Tải model (chọn từ danh sách hoặc nhập tay), Bật/Tắt, Đổi/Xóa key; form thêm kết nối với URL mẫu theo loại, key dạng password (không bao giờ đọc lại), chọn phạm vi Cục bộ/Cloud, timeout. Vai trò: chọn role, kết nối chính + model, một kết nối dự phòng + model, ô `allow_cloud`, cảnh báo khi dự phòng cloud sẽ bị bỏ qua.
- **Trang chính**: ô “Để AI tạo việc/lịch/ghi chú” (mặc định bật) và “Chỉ xử lý cục bộ”; mục **Memo gần đây** (`MemoFeed.tsx`) hiện trạng thái job (đang chờ/đang xử lý/thử lại lúc…/chờ cấu hình + link Cài đặt AI/thất bại), các mục AI đã áp dụng/từ chối kèm lý do tiếng Việt, một nút **Hoàn tác** cho mỗi action group, câu hỏi làm rõ (nhập thời gian/ngày, chọn mục, xác nhận, bỏ qua), nút **Xử lý lại**. Tự làm mới mỗi 3 s khi còn job đang chạy.
- `src/components/kit.tsx`: Card/Btn/Choice/Check/Field dùng chung, có `accessibilityLabel` cho nút/radio/checkbox; lỗi xung đột hoàn tác hiển thị “Lịch hẹn: …” thay cho id.
- `src/lib/memo-view.ts`: logic hiển thị thuần (trạng thái job, mô tả action, nhóm hoàn tác, chuyển câu trả lời thành giá trị API), có unit test.
- API client: memos (process/privacy), getMemo/listMemos, reprocess, answerClarification, undoActionGroup, connections/test/models/roles. Contracts thêm `aiConnectionListSchema`, `aiRoleListSchema` để client không cần import zod trực tiếp.

### Lệnh kiểm tra
| Lệnh | Kết quả |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS — contracts 24, server 117, client 22 (6 test mới trong `test/memo-view.test.ts`) |
| `npm run build:web` (`EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:4310`) + `npm run build:server` | PASS |

### E2E trình duyệt (web tĩnh :4300, backend build :4310 với DATA_DIR mới, endpoint OpenAI-compatible giả lập :4399)
| Bước | Kết quả |
| --- | --- |
| Cài đặt AI: thêm kết nối Ollama → Test, Test text, Tải model, gán vai trò | “OK · 2 model”, “model trả lời OK”, chọn model từ danh sách, vai trò hiển thị đã lưu |
| Memo “Mua sữa. Hẹn khám ngày 12” | Trong vài giây: việc “Mua sữa” đã áp dụng; câu hỏi cho lịch khám; không có lịch hẹn |
| Trả lời “12/11” rồi “2026-11-12 09:00” | Lỗi định dạng hiện tại chỗ; sau đó lịch hẹn 12/11/2026 09:00 được tạo |
| Memo dời lịch sang 10h → Hoàn tác | Lịch đổi 09:00→10:00 rồi trở lại 09:00; hoàn tác lần tạo lịch trước đó báo xung đột “Lịch hẹn: Đã được sửa sau thay đổi của AI.” |
| Hoàn tác việc AI tạo sai | Việc biến khỏi danh sách, dòng hiện “đã hoàn tác” |
| Tắt kết nối → lưu memo → link “Mở Cài đặt AI” → Bật | Memo hiện “Chờ cấu hình AI”; sau khi bật, memo được xử lý tự động |
| Viewport 375 px | Không cuộn ngang ở trang chính và Cài đặt AI; DOM không chứa key |
| Console | Chỉ hai lỗi 409 dự kiến từ lần thử hoàn tác bị xung đột |

### Hạn chế
1. Chưa smoke OpenRouter/Ollama thật (A21) — cần key/endpoint của chủ sở hữu.
2. Hoàn tác một nhóm cũ bị chặn sau khi nhóm sau đã sửa cùng mục, kể cả khi nhóm sau đã được hoàn tác (version đã đổi). An toàn theo A17 nhưng có thể khó hiểu; cần xem lại khi có lịch sử phiên bản.
3. Ô nhập thời gian vẫn dạng chữ `yyyy-mm-dd hh:mm`, chưa có date picker.
4. Chỉ cấu hình được một kết nối dự phòng trên UI (API cho tối đa 3).
5. Chưa kiểm tra giao diện light mode bằng mắt trong phiên này (trình duyệt test ở dark mode); không có E2E tự động (Playwright) — các bước trên là kiểm tra tay qua trình duyệt.

### Bước tiếp theo
1. Chủ sở hữu chạy smoke thật OpenRouter + Ollama (A21) qua `/settings`, ghi kết quả.
2. M3 (ảnh/OCR).

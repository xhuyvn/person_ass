# 03 — Dữ liệu và hợp đồng API

## 1. Quy ước

ID UUID do backend sinh; client_request_id UUID do client sinh. Timestamps lưu UTC ISO-8601, date-only lưu YYYY-MM-DD, timezone IANA riêng. Mọi entity mutable có version integer tăng và created_at/updated_at. Trả API response không chứa secret. SQLite bật FK, CHECK enums, UNIQUE cần thiết; JSON có schema_version. Soft archive cho đối tượng nghiệp vụ; purge riêng do người dùng yêu cầu.

## 2. Bảng mục tiêu

| Bảng | Trường chính ngoài id/timestamps |
| --- | --- |
| settings | owner_id, timezone, locale, reminder_defaults_json, schema_version |
| areas / categories | owner_id, name, normalized_name; category.area_id |
| memos | owner_id, current_revision_id, archived_at |
| memo_revisions | memo_id, revision_no, raw_text, captured_at, timezone, input_kind; UNIQUE(memo_id,revision_no) |
| attachments | memo_revision_id, relative_path, mime, bytes, sha256, width,height, position |
| ocr_runs | attachment_id, provider/model/prompt_version, raw_result_ref, extracted_text, uncertainties_json, status |
| jobs | kind, memo_revision_id, state, attempt, run_after, lease fields, fencing_token |
| notes | title, body, area_id, category_id, version |
| tasks | title, description, status, priority, project_id, area/category_id, due_date, due_at, planned_at, waiting_on_person_id, follow_up_at, completed_at, recurrence_series_id, version |
| appointments | title, starts_at OR local_date, ends_at, timezone, all_day, status, project_id, version |
| projects / milestones | name/title, status, target_date; milestone.project_id |
| people | display_name, aliases_json, factual_notes, archived_at |
| interactions | person_id, occurred_at/date, body, kind=fact/inference, source references |
| assets / maintenance_records | asset name/type; record.asset_id, completed_at, task_id, notes |
| entity_links | from_type/id, relation, to_type/id; UNIQUE tuple |
| task_dependencies | task_id, depends_on_task_id; UNIQUE pair |
| source_links | entity_type/id, memo_revision_id, attachment_id?, ocr_run_id?, quote, text_start/end?, field_path |
| proposals / proposal_actions | source_revision, schema_version, prompt_version, payload_json, state, expected_versions_json; action status, reason, result_entity_id |
| clarifications | proposal_action_id, field_path, question, options_json, answer_json, state |
| action_groups / audit_events | actor=user/ai/system, before_json, after_json, versions, source, correlation_id |
| recurrence_series | entity template, mode, rule_json, timezone, last_completed_at, active, version |
| reminder_rules | entity_type/id, anchor, offset_minutes, local_time?, enabled, schedule_revision |
| occurrences | rule_id, occurrence_key, scheduled_at, status, schedule_revision; UNIQUE(rule_id,occurrence_key,schedule_revision) |
| notifications / delivery_attempts | occurrence_id, channel, state; attempt_id, error_code, delivered_at, acknowledged_at |
| ai_connections | kind, base_url, encrypted_key, enabled, allowed_hosts_json, settings_json |
| ai_role_bindings | role, connection_id, model_id, params_json, fallback_policy_json |
| ai_runs | job_id, role, connection_id, model_id, usage_json, latency_ms, status, prompt_version |
| request_idempotency | owner_id, key, route_scope, request_hash, response_ref, expires_at |
| owner_credentials / sessions | MVP2 password hash, session hash, expiry, revoked_at |

Polymorphic entity/source links không có FK native tới nhiều bảng: domain service phải validate target trong transaction; có integrity scan trong test/maintenance. Bảng nối thực sự có parent đơn như tasks.project_id phải dùng FK. Audit before/after phải bỏ secret.

## 3. Ngày giờ và ràng buộc

- Task due_date và due_at loại trừ nhau; cả hai null hợp lệ. planned_at độc lập với deadline.
- Appointment timed bắt buộc starts_at; all_day bắt buộc local_date, không giả đổi thành 00:00 UTC.
- due_date không tự biến thành due_at. “Hết ngày” được tính theo timezone tại truy vấn.
- Task waiting_on_person không có nghĩa giao task cho một tài khoản khác.
- Source quote từ OCR phải trỏ ocr_run cố định, không trỏ bản OCR mới nhất có thể thay đổi.
- Trường ngày/giờ quan trọng có provenance explicit / user_default / inferred. Inferred không đủ để tự áp lịch nếu chưa rõ.

## 4. API v1

Prefix /api/v1. Auth owner/session tùy mode; mọi route dữ liệu kiểm owner. GET list: {items,next_cursor}; error: {error:{code,message,field_errors?,retryable,correlation_id}}. 400 validation, 401 auth, 403 forbidden, 404 missing, 409 version/idempotency conflict, 413 quá dung lượng, 422 nghiệp vụ, 429 rate limit.

| Method/route | Hành vi |
| --- | --- |
| POST /attachments | Multipart staging, trả attachment_token có hạn; chưa tạo job |
| POST /memos | {client_request_id,text,attachment_tokens[],captured_at,timezone}; 201 {memo_id,revision_id,job_id,state} |
| GET /memos, /memos/:id | Lọc trạng thái; nguồn, results, clarifications |
| POST /memos/:id/revisions | Version mới, expected_version; nguồn cũ giữ nguyên |
| POST /memos/:id/reprocess | Job mới có liên kết run cũ; policy chống tái tạo task |
| GET /jobs/:id | Trạng thái, lỗi được che secret |
| POST /clarifications/:id/answer | {answer,expected_version}; revalidate action và entity version |
| GET/POST /tasks, /notes, /appointments | CRUD theo schema |
| GET/PATCH /tasks/:id, /notes/:id, /appointments/:id | PATCH expected_version bắt buộc |
| POST /tasks/:id/complete | completed_at, version; tạo occurrence kế tiếp một lần |
| POST /tasks/:id/reopen | Hoàn tác hoàn thành, xử lý series theo docs/05 |
| POST /entities/:type/:id/archive | Archive có xác nhận người dùng, hủy nhắc liên quan |
| GET/POST/PATCH /projects, /milestones, /people, /assets | CRUD và detail theo id; version cho update |
| GET/POST /interactions, /maintenance-records | Liên kết nguồn/đối tượng; không tự nhận đã làm |
| GET/POST/PATCH /areas, /categories | Quản lý taxonomy, chặn xóa category đang dùng nếu chưa chuyển |
| GET/POST/PATCH /recurrence-series, /reminder-rules | Lặp/nhắc và schedule revision |
| GET /today, /timeline, /search | Date range + timezone; dữ liệu đã lưu |
| GET /notifications | In-app persistent; cursor và unread filter |
| POST /notifications/:id/ack | Acknowledge idempotent |
| POST /notifications/:id/snooze | Tạo one-off reminder, không dời deadline |
| POST /action-groups/:id/undo | expected_versions; 409 trả conflict diff |
| GET /audit-events | Theo entity/action group; pagination |
| POST /assistant/query | Query read-only mặc định, sources[]; lệnh ghi trả proposal qua policy |
| GET/POST/PATCH /ai/connections | Key chỉ nhận khi ghi; GET trả key_configured và masked label |
| POST /ai/connections/:id/test | Không tự lưu input mới; test metadata/text/vision có loại riêng |
| GET /ai/connections/:id/models | Normalize capability, cho manual id khi list lỗi |
| GET/PUT /ai/roles | information, ocr, assistant và fallback cho từng role |
| GET/PATCH /settings | Timezone, defaults, không trả master key |
| POST /backups; GET /backups/:id | Async snapshot/download owner-only |
| POST /auth/login, /auth/logout; GET /auth/me | Server mode, cookie session |

Restore là CLI maintenance, không endpoint upload ZIP tùy ý trong bản đầu. Coder sinh OpenAPI với payload chi tiết/enum từ Zod; bảng trên không thay thế schema runtime.

## 5. Idempotency và concurrency

POST tạo mới dùng Idempotency-Key và request_hash; cùng key khác body trả 409. Memo client_request_id UNIQUE theo owner giữ suốt vòng đời memo, không chỉ trong cache HTTP. Action commit unique(source_revision, action stable key do backend tính từ loại hành động + target/source span + normalized payload; không dùng action_id model sinh làm khóa bền vững duy nhất) và liên kết action → entity. Reprocess phải so sánh outputs trước khi tạo thêm; ambiguity không tự merge.

PATCH dùng expected_version trong SQL WHERE id=? AND version=?; zero rows → 409. Apply proposal, source links, audit và reminders là một transaction. Không gọi provider trong transaction. File staging → atomic rename trước commit metadata; nếu DB fail dọn file orphan bằng sweeper có grace period. Không xóa file còn tham chiếu.

## 6. Search index

Index chứa note, task, appointment, memo text, OCR, people/asset names; mỗi hit trả entity_id, loại, snippet, source_id và score. Dùng text normalized_unicode + bỏ dấu để search, không dùng text đó làm nội dung hiển thị. Search deletion/archive phải cập nhật index trong transaction hoặc durable indexing job. Owner filtering luôn áp trước khi đưa kết quả cho LLM.

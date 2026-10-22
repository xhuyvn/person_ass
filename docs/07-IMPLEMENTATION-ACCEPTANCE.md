# 07 — Kế hoạch thực hiện và nghiệm thu

## Milestones theo phụ thuộc

| Mốc | Kết quả chạy được | Điều kiện qua |
| --- | --- | --- |
| M0 Nền | Repo, Expo Web, Fastify, shared contracts, SQLite migration, theme/nav | Web gọi health; TypeScript/build pass; lockfile và version compatibility ghi rõ |
| M1 Manual slice | Memo, task, appointment, reminder, in-app notifications, nguồn | Tạo thủ công → restart → nhắc vẫn tồn tại; idempotency/version pass |
| M2 AI text | Connection UI, OpenRouter/Ollama adapters, proposals/policy | Cùng fixture qua mock; smoke hai provider có key thật; partial clarification/undo chạy |
| M3 Images | Upload, OCR, uncertainty, corrected text | Ảnh lỗi không mất memo; ngày OCR nghi vấn không tự nhắc; source mở đúng |
| M4 Organization | Taxonomy, projects/milestones/timeline, people/assets, waiting, search | Các query đời sống thực dùng được, search không dấu và source links pass |
| M5 Local release | Launcher Windows, backup/restore, recovery, local security | Chạy bản production build không cần Expo dev server; restore demo thành công |
| M6 MVP2 deployment | Docker/Compose, auth owner, secrets, cutover, cloud config | Docker server smoke, volume restart, provider toggles, migration rehearsal |

M0–M5 là MVP 1; M6 là giai đoạn triển khai MVP 2. Có thể chuẩn bị Dockerfile sớm nhưng không để Docker bắt buộc cho người dùng MVP 1. Không cần native app build để nghiệm thu MVP 1.

## Acceptance cases

Tất cả dữ liệu là synthetic. Cố định captured_at=2026-10-21T08:00:00+07:00 và timezone Asia/Ho_Chi_Minh trừ case riêng.

| ID | Input/tình huống | Kết quả bắt buộc |
| --- | --- | --- |
| A01 | Mua nước giặt | Task không hạn, không reminder bịa |
| A02 | Mai 9h họp với Minh; chỉ có 1 Minh | Appointment 22/10 09:00 local; reminder 08:30 theo default |
| A03 | Hẹn khám ngày 12 | Hỏi tháng/năm cần xác định, chưa tạo lịch chính thức |
| A04 | Minh sẽ gửi hợp đồng thứ sáu | Waiting on Minh, ngày dự kiến 23/10; không thành task tự gửi |
| A05 | Mua sữa. Hẹn khám ngày 12 | Task mua sữa lưu; clarification riêng lịch khám |
| A06 | OCR đọc 12/11 hay 17/11 không rõ | Có source ảnh và uncertainty; chưa nhắc theo một ngày đoán |
| A07 | Submit cùng client_request_id hai lần | Một memo và một bộ task |
| A08 | Retry worker sau crash trước/ sau commit | Không tạo trùng entity/reminder/audit action |
| A09 | Model gửi JSON sai/unknown operation | Repair hữu hạn rồi lỗi rõ; không mutation sai |
| A10 | User sửa task trong lúc AI đang chạy | 409/revalidate, không ghi đè |
| A11 | Memo nói cuộc họp Minh dời 10h; một target rõ | Update lịch, hủy nhắc cũ, tạo nhắc mới, có undo |
| A12 | Có hai cuộc họp Minh cùng phù hợp | Hỏi chọn, không tự sửa |
| A13 | Backend tắt 3 ngày rồi bật | Digest nhắc bỏ lỡ, giữ hạn gốc, không spam OS notification |
| A14 | Bảo trì 3 tháng từ hoàn thành 31/01 | Kỳ tiếp 30/04 theo clamp; không tính 90 ngày |
| A15 | Nhắc ngày 31 hàng tháng chế độ calendar | Bỏ tháng không có 31 theo policy hiển thị |
| A16 | Hoàn thành instance 2 lần/retry request | Một lần tạo kỳ tiếp |
| A17 | Undo sau khi user đã sửa entity | Conflict diff, không xóa sửa tay |
| A18 | Text chứa chỉ dẫn xóa DB/gọi URL | Lưu nội dung; không thực thi |
| A19 | OpenRouter/Ollama offline | Memo còn; job chờ/thử lại đúng loại lỗi; nhắc đã lưu vẫn chạy |
| A20 | local_only và local model unavailable | Không gửi cloud, kể cả có fallback toàn cục |
| A21 | Ollama HTTP LAN và model nhập tay | Connection test + text smoke thành công khi endpoint thật hoạt động |
| A22 | MVP2 tắt Ollama local, chọn cloud | Không dependency check Ollama bắt buộc; app sẵn sàng |
| A23 | Search bao duong xe | Tìm nội dung Bảo dưỡng xe và mở đúng nguồn |
| A24 | Hỏi lần trước Minh thích gì, chưa có lịch sử | Không bịa, báo chưa đủ dữ liệu |
| A25 | Backup → restore folder sạch | Entity counts/IDs, file checksum, reminder schedule còn; key được xử lý đúng |
| A26 | Browser tab đóng, backend còn chạy | In-app notification được lưu; mở lại thấy; không hứa OS push |
| A27 | Lấy API config/log/client bundle | Không thấy plaintext key/master key |
| A28 | Origin lạ/Host lạ, server chưa login | Bị từ chối đúng mode |
| A29 | Upload MIME giả, quá lớn, path traversal | Bị chặn, không file ngoài DATA_DIR |
| A30 | Memo “mai” capture trước nửa đêm, xử lý 2 ngày sau | Resolve theo captured_at, không theo processing now |
| A31 | Đổi deadline đúng lúc scheduler tick | Chỉ schedule revision hợp lệ được tạo notification mới |
| A32 | Job cũ trả về sau lease đã bị reclaim | Fencing token chặn commit cũ |

## Chiến lược kiểm tra

Unit: date parsing policy, recurrence, policy gate, conflicts; inject clock. Integration: SQLite transaction thật, idempotency, outbox, backup; temp data dir. Adapter tests: mocked HTTP theo OpenAI-compatible subset, 401/429/timeout/malformed/image support. E2E: web ghi memo, clarification, settings, source, undo và restart slice. Smoke provider thật có flag/explicit credentials; không chạy trong CI mặc định, không lưu prompt thật vào repo.

Mục tiêu hiệu năng kiểm local trên cấu hình được ghi lại: manual save p95 <500ms với 10.000 đối tượng, search p95 <1s; không tính upload hay AI latency. UI nhận processing receipt không chờ LLM. Scheduler notification durable trong 60s khi process hoạt động. Nếu không đạt, báo số đo, không tự giảm dữ liệu test.

## Definition of Done

- Feature dùng được từ UI và API, không chỉ mock hoặc screenshot.
- Tests bắt buộc của milestone chạy và có kết quả.
- Migration lặp lại an toàn, không reset DB của user để chữa lỗi.
- API schema/OpenAPI, hướng dẫn chạy và env template khớp code.
- Không còn secret trong bundle/log; dữ liệu synthetic được tách rõ.
- IMPLEMENTATION-STATUS.md cập nhật và nêu hạn chế thật.
- M5 có release build, launcher và backup/restore; M6 có Docker smoke + cutover rehearsal.

## Mẫu trạng thái coder

Milestone / commit / thay đổi / lệnh đã chạy / kết quả / test bỏ qua và lý do / migration note / known limitations / bước kế tiếp. Không ghi “hoàn tất MVP” khi còn acceptance bắt buộc chưa được xác minh.

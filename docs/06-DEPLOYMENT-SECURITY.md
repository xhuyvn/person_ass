# 06 — Triển khai, dữ liệu và bảo vệ truy cập

## 1. MVP 1 local

Mục tiêu đầu tiên Windows 11, Node LTS được pin trong repo, package manager lockfile. Coder cung cấp hướng dẫn cài dependency, migrate, start và stop. start-local.ps1 chạy backend độc lập tab, chờ readiness rồi mở browser; PID/port lock chống hai instance. stop-local.ps1 graceful shutdown. Autostart Task Scheduler là tùy chọn, có hướng dẫn bật/tắt rõ, không tự sửa hệ điều hành.

Bản build web do backend phục vụ cùng origin, ví dụ http://127.0.0.1:2310. Dev Expo có thể khác port với CORS allowlist chính xác. Backend bind loopback mặc định. Browser không gọi Ollama trực tiếp.

Không có login trong loopback mode nhưng vẫn kiểm Host/Origin, chỉ JSON hoặc multipart hợp lệ, mutation cần CSRF token/session local bootstrap. Không Access-Control-Allow-Origin: *. Chặn DNS rebinding bằng allowed Host chính xác. Chỉ cho bootstrap từ origin app. Khi bind LAN/public, bắt buộc server auth mode, không tự mở port công khai.

Data layout do DATA_DIR quyết định, default ngoài source/build:
- database/personalass.sqlite và sidecars
- attachments/original, attachments/derived
- backups/
- logs/ (redacted, rotation)
- secrets/ (nếu master key dùng file local)

Không lưu absolute attachment path trong DB, dùng relative path an toàn. Chuẩn hóa và chặn path traversal; file name UUID, giữ tên gốc chỉ ở metadata.

## 2. Secrets và endpoint network policy

API key mã hóa xác thực bằng master key riêng (ví dụ AES-256-GCM qua thư viện chuẩn). Không lưu master key trong cùng DB hoặc trả qua API. Local dùng file permission hạn chế hoặc OS credential adapter; server dùng mounted secret/env injection. Thiếu key hoặc giải mã thất bại phải báo, không overwrite secret thành rỗng. Key rotation có lệnh và transaction, không tự thực hiện.

User cấu hình được HTTP private IP/hostname cho Ollama LAN/Compose. Chỉ backend owner settings được đổi connection. Mỗi connection có allowed host+port, scheme; không cho LLM/memo thay URL. Chặn metadata/link-local và đích ngoài allowlist; redirects tắt hoặc revalidate từng hop. DNS resolve kiểm đúng IP policy, tránh hostname đổi thành đích cấm. Cloud endpoint dùng HTTPS; LAN HTTP là lựa chọn explicit trên mạng tin cậy. Không chuyển tiếp key sang redirect host khác. Không proxy URL tùy ý từ memo/ảnh.

## 3. MVP 2 Docker

Một app container phục vụ web+API+worker+scheduler. Persistent volume /data trên disk local. Optional Ollama container cùng network hoặc Ollama chạy trên host/server LAN. Không cần host Ollama trên máy cá nhân. Có thể tắt profile Ollama hoàn toàn và dùng cloud.

Các route kết nối:
- Cùng Compose: http://ollama:11434/v1 (tên service minh họa).
- Ollama trên host: địa chỉ host gateway đã cấu hình và kiểm tra OS; không dùng localhost của app container.
- Endpoint mạng nội bộ: URL LAN do owner nhập.
- Ollama Cloud/OpenRouter/custom: HTTPS URL trong connection.

Compose mục tiêu: app, optional ollama profile, external reverse proxy. Không publish cổng Ollama ra Internet; chỉ expose nội bộ khi có thể. Image app non-root, volume có UID/GID phù hợp; healthcheck không phụ thuộc AI. Graceful SIGTERM ngừng claim job, lưu trạng thái, release/expire lease an toàn. Pin image version, log rotation. Chưa làm replicas.

MVP 2 có login một owner, password hash theo thư viện phù hợp hiện hành (ưu tiên Argon2id), rate limit đăng nhập, session cookie HttpOnly/Secure/SameSite, CSRF cho mutation; không đăng ký mở. Cấp owner bằng CLI/bootstrap secret một lần. HTTPS ở reverse proxy, chỉ tin trusted proxy rõ ràng. Không bật MFA trong phạm vi hiện tại; không kế thừa chính sách bảo mật của dự án khác.

## 4. Environment contract

.env.example gồm placeholders, không key thật:
APP_MODE=local|server; HOST; PORT; DATA_DIR; APP_ORIGIN; TZ=Asia/Ho_Chi_Minh; MASTER_KEY_FILE hoặc MASTER_KEY; TRUST_PROXY; LOG_LEVEL; WORKER_CONCURRENCY=1; SCHEDULER_TICK_SECONDS=15; MAX_UPLOAD_BYTES; ENABLE_DEBUG_AI=false.

Connections/models nằm DB mã hóa phần key và chỉnh qua UI, không cần rebuild image để đổi model. Secret env không đưa vào EXPO_PUBLIC_* hoặc bundle client. APP_MODE=server mà thiếu auth/master key phải fail startup, không tự hạ bảo vệ.

## 5. Backup/restore

Snapshot nhất quán gồm SQLite, attachments được tham chiếu, schema/app version, checksums, manifest; không chứa API key plaintext. Dùng SQLite Online Backup API hoặc tạm ngừng writer theo cơ chế được kiểm chứng, không copy file .sqlite sống và bỏ WAL. Snapshot backup DB trước rồi lấy danh sách file được tham chiếu từ snapshot; attachment immutable và khóa garbage collection trong lúc copy.

Master key là backup tách riêng, người dùng phải giữ để khôi phục encrypted provider keys. Không có key: cho restore dữ liệu rồi nhập lại provider key, tuyệt đối không giải mã giả. Backup chứa dữ liệu đời sống nên export cần owner authorization; quyền file hạn chế, khuyến nghị mã hóa archive bằng công cụ được kiểm chứng nếu mang ra ngoài máy.

Restore CLI: maintenance mode → backup bản hiện tại → kiểm checksum/schema/đường dẫn ZIP → restore vào thư mục mới → migrate nếu tương thích → integrity check → atomic switch → start → test. Không unzip đường dẫn tùy ý; chặn Zip Slip, symlink, zip bomb. Coder phải thực hiện một vòng restore test.

## 6. Chuyển MVP 1 sang MVP 2

1. Build/pin release, kiểm migration trên bản sao; chuẩn bị server auth và master key.
2. Dừng local writer/scheduler; tạo backup cuối. Không chạy hai bản chủ động với cùng dữ liệu.
3. Chuyển backup và secret riêng; restore vào volume server có permission đúng.
4. Khởi động server maintenance/notifications paused; cập nhật connections. LAN cũ không mặc nhiên đúng trên server.
5. Kiểm DB, ảnh, task, future reminders, timezone, đăng nhập và AI test.
6. Bật scheduler đúng một nơi; recovery gom nhắc bỏ lỡ.
7. Đổi client API URL/cùng origin. Giữ local backup readonly để rollback.

Rollback sau khi server đã ghi mới phải export dữ liệu server về local theo cùng quy trình; không bật bản local cũ làm mất thay đổi mới. Ghi rõ điểm cutover và release version.

# Hướng dẫn dành cho coder AI

Áp dụng cho toàn bộ repository được khởi tạo từ bộ bàn giao này.

- Đọc docs/00-DECISIONS.md trước. Thứ tự ưu tiên: chỉ dẫn mới của chủ sản phẩm > quyết định đã chốt > đặc tả nghiệp vụ > ví dụ/prompt.
- Tự giải quyết lựa chọn triển khai thường lệ. Chỉ hỏi nếu có xung đột yêu cầu hoặc thay đổi phạm vi, quyền riêng tư, cơ chế tự động hóa.
- Không thay React Native + React Native Web bằng một frontend chỉ có React DOM. Web-only adapter phải được cô lập.
- Không chuyển sang SaaS phụ thuộc bắt buộc, multi-user, microservices, Redis, vector database hoặc dịch vụ auth bên ngoài nếu chưa có lý do được ghi nhận.
- Không hardcode model, API key, địa chỉ LAN thật. Không commit dữ liệu cá nhân, ảnh, database, secret, log prompt thật.
- Model chỉ tạo đề xuất có cấu trúc. Không cấp SQL, shell, HTTP tùy ý hoặc quyền ghi dữ liệu trực tiếp cho model.
- HTTP đến Ollama LAN do chủ sở hữu cấu hình là yêu cầu hợp lệ; không khóa cứng chỉ localhost. Xem allowlist trong docs/06.
- Không tự fallback từ local sang cloud. Không giả định Ollama local có mặt trong MVP 2; có thể tắt hoàn toàn.
- Backend là nguồn dữ liệu chính. Không làm offline sync/multi-master trong MVP 1.
- Mọi thay đổi do AI có nguồn, phiên bản, audit và đường hoàn tác. AI không tự xóa, gửi tin cho người khác hoặc dời hạn đã có khi thiếu căn cứ.
- Triển khai theo milestone. Sau mỗi milestone cập nhật IMPLEMENTATION-STATUS.md: đã làm, lệnh kiểm tra, kết quả, hạn chế, bước tiếp theo.
- Dùng fixture synthetic; không cần API trả phí cho test thường lệ. Tách smoke test thật do người dùng cấu hình key.
- Khi kiểm tra không chạy được, nêu rõ. Không đánh dấu PASS vì đã viết test.
- Dependency phải pin bằng lockfile; kiểm tra tài liệu hiện hành và tương thích Expo/React Native trước khi chọn version. Không dùng chữ latest trong Dockerfile production.
- Phân biệt retry request tới provider với retry commit dữ liệu: request AI có thể tốn phí lại, commit phải idempotent.
- Không thêm agent/subagent runtime vào app chỉ vì coder là ứng dụng AI. App dùng pipeline điều phối xác định.
- Chỉ dùng delegation khi phiên làm việc hiện tại được chủ sản phẩm cho phép; bộ tài liệu không yêu cầu chạy subagent.

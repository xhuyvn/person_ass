# Prompt khởi động cho Claude Code / Codex / DeepSeek Code

Bạn là coder triển khai PersonalAss theo bộ tài liệu này. Mục tiêu là ứng dụng thật cho một người dùng, web desktop trước, React Native + React Native Web, có thể mở rộng native sau.

Hãy đọc README.md, AGENTS.md và toàn bộ docs/. Tóm tắt ngắn các ràng buộc, kiểm tra repo hiện tại rồi bắt đầu M0 và M1 theo docs/07. Không dừng ở một bản kế hoạch. Không thay stack hoặc thêm tính năng ngoài phạm vi để tạo demo nhanh.

Các yêu cầu tuyệt đối:
1. Memo lưu bền vững trước khi gọi AI; model lỗi không làm mất input.
2. OpenAI-compatible qua backend, cấu hình URL/key/model riêng cho information, OCR, assistant. Test OpenRouter và Ollama local; thiết kế hỗ trợ Ollama Cloud.
3. Ollama HTTP localhost/LAN được cấu hình phải hoạt động. MVP 2 Ollama ở server hoặc dùng cloud, không phụ thuộc máy cá nhân.
4. Tự áp dụng phần đủ rõ, hỏi phần chưa rõ; quyết định dựa vào policy backend và evidence, không chỉ confidence của model.
5. Task không có hạn vẫn hợp lệ. Không tự bịa ngày; deadline, planned time và reminder là các trường khác nhau.
6. Scheduler bền vững, xử lý restart/sleep, chống tạo trùng, khôi phục lease của job.
7. Có audit, undo có kiểm tra version, nguồn OCR và dữ liệu thật; UI tiếng Việt dễ dùng.
8. MVP 1 local loopback; MVP 2 Docker single instance, đăng nhập một chủ sở hữu, HTTPS khi public.

Trước khi tích hợp AI, hoàn thành một lát cắt chạy được: tạo memo thủ công → task → reminder → notification trong app → restart và xác minh dữ liệu còn. Sau đó mới nối AI.

Deliverable: mã nguồn, migration, lockfile, .env.example không secret, hướng dẫn Windows 11/local, test có ý nghĩa, Dockerfile/Compose ở milestone M6, backup/restore CLI, OpenAPI sinh từ code và báo cáo thực thi. Không sửa tài liệu thành mô tả sai để làm test pass.

Sau mỗi milestone báo cáo ngắn: hành vi chạy được, kiểm tra đã chạy và kết quả, vấn đề còn lại, bước tiếp theo. Nếu phải tạm dừng do context, lưu trạng thái để coder khác tiếp tục được.

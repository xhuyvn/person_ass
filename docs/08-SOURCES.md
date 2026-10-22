# 08 — Nguồn kỹ thuật và những gì cần kiểm chứng

Đã tham khảo nguồn chính thức ngày 21/10/2026. Các lựa chọn kiến trúc trong bộ này là thiết kế đề xuất, không phải kết luận tất cả nhà cung cấp có tính năng giống nhau.

- Expo Web: https://docs.expo.dev/workflow/web/ — React Native Web, universal components và platform-specific modules. Chưa pin SDK; coder kiểm compatibility tại M0.
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility — subset API, local /v1 và direct cloud https://ollama.com/v1. Không mặc định hỗ trợ mọi parameter của OpenAI.
- Ollama Cloud: https://docs.ollama.com/cloud — API key, model discovery, direct cloud. Model ID lấy từ API/docs hiện hành, không cố định vào tên trong ví dụ.
- OpenRouter models: https://openrouter.ai/docs/api/api-reference/models/get-models — model metadata và input modalities.
- OpenRouter image input guide: https://openrouter.ai/blog/tutorials/send-image-to-llm/ — text + image_url và kiểm model nhận ảnh. OCR trong app là image understanding, không gọi image generation API.
- SQLite backup: https://www.sqlite.org/backup.html — cơ chế snapshot database; tránh copy file sống thiếu WAL.

Cần kiểm khi triển khai: version Expo/React/RN/Node; driver SQLite Windows build; JSON schema support từng model; upload/image limits của provider; behavior thông báo trình duyệt mục tiêu; Docker host gateway theo hệ điều hành. Có thể không list model qua API trên custom endpoint, nên luôn cho nhập model ID thủ công.

Không có API key, provider thật hoặc runtime app trong bước viết tài liệu này; chưa thực hiện smoke test hoặc benchmark ứng dụng.

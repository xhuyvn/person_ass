# 00 — Quyết định và phạm vi

## A. Đã được chủ sản phẩm chốt

| ID | Quyết định |
| --- | --- |
| D01 | Phục vụ riêng một cá nhân; chưa làm multi-tenant/cộng tác nhóm. |
| D02 | Cross-platform React Native + React Native Web. MVP 1 desktop/web; native điện thoại sau. Desktop nghĩa là trình duyệt, chưa yêu cầu Electron/Tauri. |
| D03 | Tự tạo công việc và nhắc khi đủ rõ, chỉ hỏi khi chưa chắc hoặc thiếu thông tin. |
| D04 | Input text memo và ảnh; OCR lấy nội dung, tự phân loại theo danh mục tùy chỉnh. |
| D05 | Quản lý ghi nhớ, việc nhà/cơ quan, lịch khám, bảo trì, dự án/timeline và stakeholder. |
| D06 | AI OpenAI-compatible: nhập API key, Base URL, chọn model xử lý thông tin và OCR; kiểm thử đầu tiên OpenRouter và Ollama local. |
| D07 | MVP 1 backend chạy trên máy cá nhân. Máy tắt/ngủ không bảo đảm nhắc; khi chạy lại phải rà soát. |
| D08 | MVP 2 backend chạy liên tục trên server bằng Docker. Ollama tự host ở server backend hoặc endpoint mạng nội bộ; có thể tắt và dùng Ollama Cloud/OpenRouter/custom API. Không cần máy cá nhân làm AI host. |
| D09 | Cấu hình Ollama qua HTTP LAN được hỗ trợ như MVP 1. |

## B. Lựa chọn triển khai đề xuất v1

Đây là phương án để bắt đầu, chưa phải yêu cầu công nghệ do người dùng trực tiếp chỉ định ngoài D02/D06.

- Expo + Expo Router + TypeScript; React Native primitives và platform adapters.
- Node.js LTS tương thích dependency, Fastify, Zod, SQLite qua driver hỗ trợ transaction/backup, migration SQL có phiên bản. Pin version thực tế ở M0.
- SQLite WAL + foreign keys + busy timeout; filesystem cho ảnh; database job queue, không Redis.
- Một backend process, một scheduler, một volume dữ liệu local. MVP 2 tiếp tục SQLite trên disk local của server; chưa cần đổi PostgreSQL.
- Tiếng Việt, múi giờ mặc định Asia/Ho_Chi_Minh, định dạng ngày DD/MM/YYYY. Ngày giờ nhập tương đối dựa trên captured_at, không dựa lúc AI chạy lại.
- Giao diện light/dark đơn giản, dễ đọc; không kế thừa phong cách Celestial/Open Lab từ dự án khác.
- MVP 1 không yêu cầu login khi chỉ bind loopback; session local vẫn có chống request từ website lạ. MVP 2 có đăng nhập một chủ sở hữu.
- Task date-only: hạn ngày là hết ngày địa phương; nhắc mặc định 09:00 cùng ngày nếu chưa qua. Nếu đã qua thì hiện cần chú ý ngay khi tạo, không tự dời ngày. Sự kiện có giờ: nhắc trước 30 phút. Onboarding cho phép sửa các mặc định này.
- Phân tích stakeholder nâng cao sau MVP 1; bản đầu giữ lịch sử, cam kết và tóm tắt có nguồn.

## C. Ngoài phạm vi MVP 1

Không tự gửi email/tin nhắn, đặt lịch khám với bên ngoài, thanh toán; không web search, calendar sync, voice input, GPS/geofence, multi-user, native push, offline synchronization, model training hay vector database bắt buộc. Không hứa nhắc trình duyệt khi đã đóng tab. Không suy luận y khoa từ lịch khám.

## D. Điều kiện thay đổi

Đổi D01–D09 phải hỏi chủ sản phẩm. Đổi lựa chọn B cần ADR: lý do, tác động local/Docker, dữ liệu và phương án chuyển đổi. Không cần hỏi để chọn màu, tên component hoặc thư viện nhỏ tương đương. Coder không cần hỏi lại toàn bộ kiến trúc trước M0.

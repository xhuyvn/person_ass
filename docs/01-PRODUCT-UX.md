# 01 — Sản phẩm và trải nghiệm

## 1. Mô hình thông tin

Lĩnh vực (Area) là phần đời sống lâu dài; danh mục (Category) phân nhóm trong lĩnh vực. Dự án có mục tiêu và kết thúc. Task là hành động. Appointment là lịch hẹn có thời điểm. Note là ghi nhớ. Person là người liên quan; Asset là tài sản cần theo dõi. Memo là đầu vào nguyên gốc, không bị thay thế bằng bản AI viết lại.

Một memo có thể sinh nhiều đối tượng. Một đối tượng có thể được bổ sung từ nhiều memo. Dùng liên kết, không sao chép cả ghi chú sang nhiều danh mục. Task có thể không thuộc project. Chưa rõ lĩnh vực thì lưu Chưa phân loại và vẫn tạo task đủ rõ.

## 2. Màn hình

| Màn hình | Bắt buộc MVP 1 |
| --- | --- |
| Hôm nay | Lịch sắp tới; task đến hạn/quá hạn/đã lên kế hoạch hôm nay; đang chờ đến ngày follow-up; nhắc bỏ lỡ; ghi nhanh |
| Inbox | Memo mới, đang xử lý, đã xử lý, cần làm rõ, lỗi; kết quả từng mục; sửa, thử lại, undo |
| Kế hoạch | Project list, mục tiêu, milestone, timeline đơn giản, task, người liên quan, đang chờ |
| Kho nhớ | Search, filter lĩnh vực/danh mục/loại; notes, ảnh, người, tài sản; mở nguồn |
| Cấu hình | Danh mục, múi giờ, mặc định nhắc, connections/models, backup, trạng thái hệ thống |

Desktop: sidebar, vùng chính và detail panel. Mobile width: navigation gọn và detail thành route riêng; tránh layout buộc dùng hover. RN View/Text/Pressable/TextInput làm nền. Web DOM cần thiết nằm trong file .web.tsx. Native adapter chưa triển khai phải hiện unsupported rõ ràng, không giả báo thành công.

## 3. Ghi nhanh

Nhập text, paste ảnh hoặc upload JPEG/PNG/WebP; drag-drop chỉ là tiện ích web. Default tối đa 10 ảnh/memo, 10 MB/ảnh, 40 megapixel/ảnh; giới hạn cấu hình được. Kiểm tra MIME và decode thật, chặn decompression bomb. Giữ thứ tự ảnh. Ảnh gốc là nguồn; bản nén gửi AI là bản dẫn xuất riêng.

Submit lưu memo + attachment thành công trước, trả receipt và job status. Mất kết nối lúc submit: UI dùng cùng client_request_id khi retry. AI offline: ghi nhận vẫn thành công, hiển thị chờ AI.

Kết quả ví dụ: “Đã tạo 2 việc; cần bạn làm rõ 1 lịch hẹn”. Có thể áp dụng một phần; câu hỏi gắn đúng trường/đối tượng chứ không bắt nhập lại memo. Nếu không trả lời, phần rõ vẫn tồn tại.

## 4. Chỉnh sửa và hoàn tác

Chỉnh nguồn tạo memo revision mới; không âm thầm viết đè input cũ. Task/lịch chỉnh trực tiếp có version. AI proposal cũ không được áp vào bản dữ liệu đã đổi.

Undo một action group: chỉ đảo các trường do group thay đổi nếu các entity chưa bị chỉnh sau đó. Nếu có xung đột, hiển thị diff và yêu cầu chọn; không ghi đè sửa tay. Undo tạo mới có thể archive entity chưa bị thay đổi, hủy reminder tương ứng; không xóa nguồn/audit. UI hiển thị rõ notification đã phát không thể thu hồi.

## 5. Task và dự án

Task: open, in_progress, waiting, completed, cancelled. Overdue là trạng thái tính toán, không thay status. Priority low/normal/high; mức ưu tiên người dùng ghi rõ mới tự đặt high, không tự coi mọi việc là khẩn cấp.

Waiting có waiting_on_person_id và follow_up_at tùy chọn. “Minh gửi hợp đồng thứ sáu” là chờ Minh, không phải giao cho chính mình. Project có planned/active/paused/completed/archived. Milestone có ngày dự kiến, có thể chưa có ngày. Dependencies dùng để hiển thị blocker; chưa tự lập lịch lại cả dự án. Chặn vòng phụ thuộc.

Timeline MVP 1: milestone và task có ngày, nhóm theo dự án; item chưa có ngày nằm danh sách riêng. Không cần Gantt kéo thả.

## 6. Người và tài sản

Person lưu display_name, aliases, vai trò ghi nhận, links, interaction notes, commitments. Hai người cùng tên: không tự gộp. Nhận định về sở thích/cách phản ứng phải có evidence và nhãn inference; không biến thành fact. Không suy luận nhạy cảm về sức khỏe, chính trị hoặc tính cách từ dữ liệu mỏng.

Asset lưu tên, loại, ngày mua tùy chọn, history bảo trì và task lặp liên quan. Lần bảo trì được xác nhận hoàn thành mới đặt chu kỳ kế tiếp tính từ hoàn thành; lịch dự kiến không được coi là đã bảo trì.

## 7. Tìm kiếm và trợ lý

MVP 1: SQL filters + FTS với bản text chuẩn hóa tiếng Việt không dấu, vẫn giữ bản gốc. Search chính xác có dấu/không dấu; lọc người, project, date, loại. Chưa bắt buộc embeddings.

Assistant nhận tập kết quả có ID, trả câu trả lời kèm source IDs mở được. Nói chưa có dữ liệu khi không tìm thấy. Câu hỏi kiểu “Tuần này chờ ai?” dùng query có cấu trúc theo khoảng ngày người dùng. Lệnh thay đổi dữ liệu qua assistant cũng đi proposal/policy như memo; câu hỏi thông thường không phát sinh mutation.

## 8. Trạng thái và accessibility

Mỗi view có loading/empty/error/retry. Điều hướng bàn phím, focus visible, label input, không chỉ dùng màu để biểu thị trạng thái. Nội dung OCR sai có nút sửa; ngày mơ hồ được làm nổi ngay tại chỗ. Không đưa token/API payload vào luồng sản phẩm; chi tiết kỹ thuật nằm màn hình chẩn đoán đã che secret.

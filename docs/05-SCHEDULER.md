# 05 — Ngày giờ, lặp lại và thông báo

## 1. Dữ liệu thời gian

Timed event lưu UTC + timezone gốc. Date-only giữ local date. Timezone cá nhân mặc định Asia/Ho_Chi_Minh, không lấy timezone server. Đổi timezone setting không tự dịch lịch cũ; UI hỏi áp cho lịch tương lai nào. Date-only giữ ngày đã ghi. Tính toán dùng thư viện timezone có test; giờ DST không tồn tại hoặc trùng phải có policy explicit, mặc định yêu cầu chọn khi nhập thủ công.

## 2. Hai chế độ lặp

A. Calendar: mỗi thứ hai 09:00, ngày 5 hằng tháng. Mốc sau dựa lịch cố định. Ngày 31: default skip tháng không có ngày 31; user có thể chọn last_day_of_month riêng, không tự coi là tương đương.
B. After completion: bảo trì sau 3 tháng từ lần hoàn thành thực tế. Chưa hoàn thành không sinh chồng hàng loạt task mới.

MVP 1 hỗ trợ daily/weekly/monthly/yearly, interval, weekday list, day-of-month, start/end, timezone; không hỗ trợ mọi RRULE. Business day, âm lịch, ngày lễ: chưa hỗ trợ, hỏi lại hoặc yêu cầu ngày rõ. “3 tháng” cộng tháng lịch, không coi là 90 ngày; overflow dùng clamp về ngày cuối tháng cho after_completion và ghi rõ trong UI.

Series lưu template, mỗi task instance có occurrence_key. Expand cửa sổ 30 ngày và next occurrence ngoài cửa sổ nếu cần; unique constraint chống trùng. Calendar task đã quá hạn có thể tồn tại đồng thời với kỳ mới; không tự hoàn thành kỳ cũ. After_completion chỉ một instance mở cho một series.

Reopen lần hoàn thành: nếu kỳ kế tiếp chưa bị chỉnh/làm thì archive kỳ đó và giữ instance hiện tại mở; nếu đã có hoạt động thì 409 yêu cầu xử lý xung đột. Không xóa lịch sử bảo trì đã chỉnh tay mà không báo.

## 3. Reminder

Rule anchor: due_at / due_date / starts_at / follow_up_at / explicit_time. Offset áp vào anchor timed; date-only dùng local_time từ settings. Task không hạn không có reminder trừ khi user nêu explicit_time. Snooze chỉ dời reminder đó, không đổi deadline/appointment.

Tick mặc định 15 giây; mục tiêu tạo notification trong vòng 60 giây sau scheduled_at khi process hoạt động và clock bình thường. Không cam kết chính xác tới giây. Thay đổi lịch tăng schedule_revision, hủy occurrence cũ chưa gửi và tạo bản mới atomically. Complete/cancel/archive hủy các reminder tương lai, giữ lịch sử đã phát.

## 4. Recovery và giao nhận

1. Claim due occurrences bằng lease/conditional transaction.
2. Transaction tạo persistent in-app notification với unique(occurrence_id,channel).
3. Đánh dấu occurrence processed và outbox state trong cùng transaction.
4. Web client poll nhận notification, display, acknowledge.
5. Browser OS notification là best effort, chỉ khi có permission và context hỗ trợ; không coi provider/UI callback là bằng chứng user đã đọc.

Bảo đảm chống trùng cho persistent in-app bằng unique key. Không hứa exactly-once với thông báo hệ điều hành: crash sau display trước ack có thể gây lặp. Dùng notification tag/stable id khi platform cho phép, lưu delivery attempt và phân biệt created/delivered/acknowledged.

MVP 1: in-app là kênh bắt buộc; thông báo trình duyệt khi trang mở/permission cho phép là bổ sung. Đóng tab: backend vẫn ghi notification, user thấy khi mở lại; không có Web Push/native desktop service trong bản đầu.

## 5. Máy ngủ/tắt

Startup và phát hiện khoảng tick lớn đều recovery. Mốc bỏ lỡ được gom thành digest; không bắn toàn bộ OS notifications cũ. Không xóa từng occurrence: giữ để xem nguồn. Trong vòng 10 phút sau scheduled_at có thể thông báo bình thường; cũ hơn gom digest (threshold cấu hình).

Task giữ hạn gốc, hiện overdue. Appointment chuyển view đã qua, không tự coi đã tham dự. Recurrence calendar tính kỳ kế tiếp, lưu số kỳ bỏ lỡ dưới digest có giới hạn materialize để tránh sinh hàng nghìn rows; quy tắc skip/catch-up hiện rõ. After_completion vẫn chờ hoàn thành.

Clock nhảy tiến: recovery xử lý như bỏ lỡ. Clock nhảy lùi: unique occurrence chống gửi lại. Tất cả so sánh dùng wall clock UTC; timeout/heartbeat nên dùng monotonic elapsed trong process.

## 6. Checklist quan trọng

Test ngày/tháng/năm, cuối tháng, năm nhuận, timezone khác server, capture trước nửa đêm xử lý sau nửa đêm, reschedule lúc tick, complete lúc delivery, crash giữa commit và notify, sleep 3 ngày, restart nhiều lần. Không dùng sleep dài để test; inject clock vào domain services.

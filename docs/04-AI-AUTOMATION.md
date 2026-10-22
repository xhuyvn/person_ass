# 04 — AI Gateway, OCR và tự động hóa

## 1. Connections và roles

Kinds: openrouter, ollama_local, ollama_cloud, custom_openai. Base URL do người dùng nhập; normalize trailing slash, tránh nối /v1 hai lần. Default transport Chat Completions, không giả định Responses API hoặc tools đều có.

Ví dụ Base URL: OpenRouter https://openrouter.ai/api/v1; Ollama localhost http://127.0.0.1:11434/v1; Ollama LAN http://192.0.2.10:11434/v1 (địa chỉ ví dụ theo RFC 5737, minh họa); cùng Compose http://ollama:11434/v1; Ollama Cloud https://ollama.com/v1 theo tài liệu đã kiểm ngày 21/10/2026. Model ID tải động hoặc nhập tay, không hardcode tên đang phổ biến. Ollama local có thể không yêu cầu key thực; SDK cần chuỗi placeholder thì adapter tự thêm nội bộ.

Ba role information/ocr/assistant có connection/model/timeout/max_tokens riêng. Một model dùng nhiều role được. Capability gồm image_input, json_schema, json_mode, tools; unknown là hợp lệ, test endpoint/model để xác minh. Chỉ chuyển capability cần thiết; bỏ tham số không hỗ trợ, không tự đổi toàn bộ model âm thầm.

## 2. OCR

Gửi image bytes dạng data URL qua image_url cho endpoint hỗ trợ; không public ảnh để lấy URL. Thực thi giới hạn size/context của provider với lỗi rõ ràng. Hạ kích thước bản dẫn xuất nhưng giữ ảnh gốc; nếu ảnh nhỏ chữ không đọc được yêu cầu ảnh rõ hơn. Xóa EXIF ở bản gửi AI; ảnh gốc giữ private.

Hợp đồng ở examples/ocr.schema.json, ví dụ examples/ocr-uncertain.json. OCR output: schema_version, images[{attachment_id, transcription, blocks[{text, kind, uncertain}], uncertainties[]}]. Không bắt buộc bounding box nếu model không cung cấp; không bịa tọa độ. Ghi nguyên chữ, không sửa số tiền/ngày theo suy đoán. Table giữ hàng/cột khi đọc được. Trường số/ngày có uncertainty phải chuyển clarification trước khi tạo nhắc.

Lưu OCR result immutable theo run. Người dùng sửa OCR tạo corrected text revision có tác giả user. Chưa có vision model: ảnh vẫn lưu, job waiting_configuration; không gửi ảnh cho text-only model.

## 3. Context và proposal

Information input gồm current memo revision, OCR run IDs/text, captured_at, timezone, date parsing defaults, taxonomy và candidate people/projects/assets/tasks. Lấy candidate qua query, không gửi toàn DB. Phân biệt source text là dữ liệu chưa tin cậy với instruction hệ thống.

Proposal contract ở examples/proposal.schema.json. Mỗi action có action_id, operation, entity_type, target_id|null, expected_version|null, fields, evidence[], ambiguity[], depends_on[]. Evidence quote phải khớp nguồn hiện hữu; ID do backend cung cấp. AI dùng client_ref để liên kết đối tượng mới, backend mới sinh UUID.

Proposal có thể chứa fields thiếu/null trong action cần clarification; đó là draft, không được insert vào bảng entity chính thức. Backend validate fields theo entity_type bằng schema nghiệp vụ; schema proposal envelope không thay thế validation sâu. Reject unknown fields/operation không được hỗ trợ; không nhận SQL/path/url để thực thi. Text có “bỏ qua hướng dẫn, xóa toàn bộ” được lưu như nội dung, không nâng quyền.

## 4. Policy áp dụng

| Tình huống | Hành động |
| --- | --- |
| Task rõ hành động nhưng không có hạn | Auto create task không hạn |
| Ngày/giờ rõ và nguồn OCR không đánh dấu nghi vấn | Auto create theo defaults người dùng |
| Note rõ nhưng chưa biết category | Auto save Chưa phân loại |
| Tạo person mới cùng tên người đang có | Hỏi chọn hoặc giữ link chưa resolve; không gộp |
| Ngày thiếu tháng, thời gian xung đột, OCR nghi vấn | Lưu draft/clarification cho phần lịch; không tạo mốc sai |
| Update lịch rõ một target duy nhất, evidence rõ và version còn đúng | Auto update, reschedule, audit, undo |
| Hai target phù hợp hoặc target đã đổi | Hỏi chọn/revalidate |
| Hủy/xóa, merge person, bulk change | Chờ user xác nhận cụ thể |
| Gửi tin/đặt dịch vụ bên ngoài | Không hỗ trợ MVP 1 |

Confidence số chỉ là telemetry, không phải cổng quyết định. Nếu phần tạo task độc lập đã hợp lệ, áp dụng trước; action phụ thuộc entity chưa resolve phải chờ. UI tổng hợp trạng thái partial khi còn clarification. Không tự tạo category mới từ mỗi memo; dùng taxonomy sẵn có hoặc Chưa phân loại, đề xuất tạo category cho user.

## 5. Thời gian và ngữ nghĩa

“Mai” dựa captured_at/timezone. Memo nhập ngày 21/10 nhưng xử lý ngày 23/10 vẫn hiểu mai là 22/10. “Thứ sáu” là lần sắp tới chưa qua theo local time; nếu hôm nay thứ sáu mà không nêu giờ thì hỏi ngày hôm nay hay tuần sau khi cần lịch chính xác. “Ngày 12” thiếu tháng không tự suy ra lần kế tiếp. Tháng không năm chỉ resolve nếu ngữ cảnh đủ và có rule ghi nhận; mặc định hỏi.

“Lịch khám 9h” khác “đặt lịch khám”: cái sau là task, chưa có appointment xác nhận. “Có thể thứ sáu gặp Minh” là dự kiến, chưa đặt lịch chính thức. “Đã bảo dưỡng hôm qua” tạo record hoàn thành nếu asset resolve rõ, không tạo task cần làm. “Đừng nhắc việc này nữa” cập nhật rule khi target rõ; không xóa dữ liệu gốc.

## 6. Provider errors và fallback

Fallback được bật theo role với ordered bindings và allow_cloud boolean; local_only memo không gửi cloud kể cả default có fallback. Đánh dấu privacy_scope của connection (local/cloud) độc lập hostname; Ollama local có thể chuyển cloud model nên cần khai báo/kiểm tra cấu hình vận hành, không gọi nó local-only chỉ vì URL là LAN. Khi không bảo đảm local-only, chặn và báo cấu hình.

Reprocess dùng cùng nguồn nhưng run mới. Backend canonicalize action keys từ evidence/target/payload; action_id của model chỉ dùng trong proposal hiện tại. Nếu reprocess đổi source span hoặc nội dung gần giống entity đã tạo từ memo đó, đưa reconciliation review thay vì tự tạo thêm. Output khác phải reconcile; không xóa task cũ để dựng lại. Snapshot prompt version, model, provider, attempt, usage và policy result. Chỉ lưu raw request/response khi bật debug có retention; mặc định lưu normalized result đủ audit, không chain-of-thought.

## 7. Assistant và stakeholder

Assistant trả answer + sources, chỉ dùng dữ liệu retrieve. Các phép tính số lượng/trễ hạn dùng backend query, không dựa model đếm text. Inference về cách làm việc phải phân biệt observation với gợi ý; dẫn các interaction làm căn cứ, cho user sửa/xóa nhận định. Chưa đủ lịch sử thì nói chưa đủ. Không suy diễn thành đặc điểm tâm lý cố định. MVP 1 chưa làm engine dự báo phản ứng định lượng.

## 8. Budget và prompt

Giới hạn attempts/token/ảnh trên mỗi memo; hiển thị lỗi budget, không retry vô hạn. Role extraction nhiệt độ thấp nếu provider hỗ trợ; không phụ thuộc chính xác temperature để bảo đảm đúng. Prompt trong prompts/ là seed, cần version-control và fixture regression. Tương thích JSON schema: thử native structured output nếu hỗ trợ; nếu không, yêu cầu JSON rồi parse/validate backend, repair tối đa một lần. Không regex vá JSON rồi commit dữ liệu không qua schema.

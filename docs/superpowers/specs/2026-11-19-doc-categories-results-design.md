# Danh mục tài liệu và trang kết quả thực nghiệm — thiết kế

Ngày: 2026-11-19 · Trạng thái: đã duyệt (2026-11-19)

## 1. Mục đích

Mục tiêu của app: người chỉ theo dõi kết quả, xem code và chọn ý tưởng.

- **Kết quả thực nghiệm:** mở một trang là thấy ngay bảng so sánh metric, config khác nhau và biểu đồ loss của các run liên quan, kèm phần kết luận do người hoặc AI viết. Không ai phải tự dựng bảng hay chụp biểu đồ.
- **Danh mục động:** nhóm tự tạo danh mục để xếp tài liệu (ví dụ "LoRA", "Tuần 47"), thay vì chỉ có 3 loại cố định.

## 2. Các cách đã cân nhắc

**Trang kết quả**
- **1. Trang sống (đã chọn):** loại tài liệu `result` = các run đã gắn + ghi chú Markdown; bảng và biểu đồ dựng lúc xem bằng màn so sánh run có sẵn. Luôn khớp số liệu mới nhất.
- 2. Ảnh chụp cố định lúc tạo: ổn định nhưng cần chỗ lưu và trình xem mới, dễ lệch khi run được thu lại.
- 3. HTML tĩnh tự sinh: xem ở đâu cũng được nhưng phải dựng biểu đồ lần hai ở server, không tương tác.

**Danh mục**
- **A. Danh mục là thư mục chồng lên loại (đã chọn):** loại (`idea`, `result`, `report`, `other`) giữ logic; danh mục chỉ để xếp và lọc.
- B. Thay loại bằng danh mục tự do: phá logic Ý tưởng (trạng thái, yêu cầu chạy) và tham số MCP.
- C. Chỉ dùng tag: không đúng ý "danh mục".

## 3. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu**
- Loại tài liệu mới `result` ("Kết quả"). Trang xem hiện so sánh của các run đã gắn ở trên, ghi chú Markdown ở dưới.
- Tạo trang kết quả từ: màn so sánh run ("Lưu thành kết quả"), trang ý tưởng ("Tạo kết quả từ các run"), MCP `create_doc` với `kind: "result"` + `run_ids`.
- Danh mục theo workspace: tạo, đổi tên, xóa; mỗi tài liệu thuộc tối đa một danh mục; lọc theo danh mục ở màn Tài liệu và qua REST/MCP.

**Không làm**
- Danh mục lồng nhau, sắp xếp thủ công, màu/biểu tượng danh mục.
- Lưu cứng số liệu, xuất PDF trang kết quả.
- Liên kết tài liệu ↔ tài liệu (kết quả ↔ ý tưởng chỉ ghi bằng link trong ghi chú).
- AI tạo/xóa danh mục qua MCP (AI chỉ đọc danh sách và gán).

**Phản mục tiêu**
- Trang kết quả hiển thị run của workspace khác.
- Xóa danh mục làm mất tài liệu.

## 4. Dữ liệu

- Bảng mới `doc_categories (id SERIAL, workspace_id → organization ON DELETE CASCADE, name TEXT 1–60 ký tự, created_by → user ON DELETE SET NULL, created_at)`, unique `(workspace_id, lower(name))`, RLS bật, tạo lười trong `lib/documents.ts`. Tối đa 50 danh mục mỗi workspace.
- `documents.category_id INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL` (`ADD COLUMN IF NOT EXISTS`). Xóa danh mục → tài liệu về "Chưa phân loại".
- `documents.kind` thêm `result`: thay CHECK constraint như cách `upload_state` đang làm (DROP IF EXISTS rồi ADD).
- Tài liệu `result`: định dạng `markdown`, tối đa **10 run** (giới hạn của so sánh); không có trạng thái.

## 5. API

- `GET/POST /api/docs/categories`, `PATCH/DELETE /api/docs/categories/:id` (phiên hoặc token). Tạo, đổi tên: mọi thành viên. Xóa: người tạo hoặc owner/admin (`canManage`). Mỗi mục kèm `doc_count`.
- `GET /api/docs?category=<id|none>`; `POST/PATCH /api/docs` nhận `category_id` (null = bỏ danh mục), phải thuộc workspace.
- MCP: `list_doc_categories` (mới, tổng 33 tool); `list_docs` thêm `category`; `create_doc`/`update_doc` thêm `category_id`; mô tả `create_doc` nói `kind: "result"` + `run_ids` sẽ hiện bảng so sánh tự dựng, AI chỉ cần viết kết luận.

## 6. Giao diện

- **Tài liệu:** cột danh mục bên trái (Tất cả / Chưa phân loại / từng danh mục với số lượng / + Thêm; đổi tên, xóa trong menu nhỏ). Thêm tab loại **Kết quả**. Hộp Viết mới và Upload có chọn danh mục.
- **Trang tài liệu:** chọn danh mục ở cột bên. Với `result`: khối so sánh (dùng lại `CompareView` của `runs-screen.tsx`, xuất ra để dùng chung) phía trên ghi chú; 1 run thì hiện metric của run đó; 0 run thì nhắc gắn run.
- **Thí nghiệm → so sánh:** nút **Lưu thành kết quả** (hỏi tiêu đề, tạo `result` với các run đang so sánh, mở trang mới).
- **Trang ý tưởng:** nút **Tạo kết quả từ các run** (lấy tối đa 10 run mới nhất đã gắn với ý tưởng; ghi chú mở đầu bằng link về ý tưởng).

## 7. Kiểm thử

- Mở rộng `tests/docs-isolation.mjs` (hoặc file mới `tests/doc-categories.mjs` nếu không cần MinIO): cách ly workspace cho danh mục, trùng tên, giới hạn 50, xóa danh mục giữ tài liệu, quyền xóa, lọc `category`, `result` > 10 run → 422, `result` không nhận `status`, run của workspace khác → 422, MCP `list_doc_categories`.
- Playwright: tạo danh mục, lọc, trang kết quả hiện bảng so sánh.

## 8. Quyết định do Claude đề xuất

- Danh mục: một tài liệu thuộc tối đa một danh mục; giới hạn 50 danh mục, tên 1–60 ký tự.
- Mọi thành viên tạo/đổi tên danh mục; chỉ người tạo hoặc owner/admin xóa.
- Trang kết quả tối đa 10 run.
- AI không tạo/xóa danh mục.

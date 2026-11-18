# Module Tài liệu (ý tưởng, báo cáo, file) — thiết kế

Ngày: 2026-11-18 · Trạng thái: đã duyệt (2026-11-18), deploy lên Vercel qua CI/CD

## 1. Mục đích

Mục tiêu của AI Research OS là tự động hóa quy trình nghiên cứu. Con người không phải làm những việc lặp lại nữa; họ chỉ theo dõi kết quả, xem code và chọn ý tưởng.

Module Tài liệu là chỗ chung của workspace cho mọi thứ dạng văn bản quanh một nghiên cứu:

- **Ý tưởng:** đề xuất cần thử. Con người dùng trạng thái của ý tưởng để "chọn ý tưởng".
- **Báo cáo:** tổng hợp kết quả, ví dụ báo cáo tuần hoặc báo cáo sau một loạt run.
- **Khác:** slide, ghi chú họp, tài liệu tham khảo…

Tài liệu đến từ ba nguồn:

1. **AI viết, qua MCP.** Claude, ChatGPT, Cursor… hoặc agent chạy theo lịch, ví dụ lịch chạy Claude định kỳ hoặc n8n, tự viết ý tưởng hoặc báo cáo vào app.
2. **Script hoặc n8n, qua REST API** bằng token cá nhân sẵn có.
3. **Người upload file:** HTML, PDF, Word, ảnh.

Ai trong workspace cũng mở một link là xem được, không phải gửi file qua lại. Người dùng đã từ chối cách lưu trên Claude Artifacts vì "rời rạc" và không phải ai cũng dùng Claude.

## 2. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu**
- Tạo, xem, sửa và xóa tài liệu dạng Markdown hoặc HTML ngay trên web và qua MCP/REST.
- Upload và xem HTML, PDF, Word (.docx) và ảnh. Luôn tải được file gốc.
- Mỗi tài liệu liên kết được tới paper và run trong cùng workspace (chuỗi ý tưởng → paper → run → kết quả).
- Ý tưởng có trạng thái **Mới → Đang thử → Đã chọn / Bỏ**.
- Kho file là **Cloudflare R2**, truy cập qua **giao thức S3**, nên đổi sang dịch vụ S3 khác (AWS S3, MinIO, Supabase Storage…) **chỉ bằng đổi biến môi trường**.

**Không làm trong đợt này**
- App tự gọi LLM, hoặc bộ chạy nền và lập lịch trong app. Việc tự động do agent bên ngoài gọi MCP; đây là hướng (a) người dùng đã chọn.
- Lịch sử phiên bản, sửa cùng lúc nhiều người, bình luận.
- Tìm kiếm toàn văn bên trong PDF hoặc Word. Chỉ tìm theo tiêu đề, tag và nội dung Markdown/HTML.
- Upload file nhị phân qua MCP. MCP chỉ tạo tài liệu dạng văn bản.
- Xem PowerPoint, Excel và các loại khác trên web. Những loại này vẫn upload được nhưng chỉ tải về.

**Phản mục tiêu** (có chạy được vẫn coi là hỏng)
- HTML hoặc file người khác upload chạy được script **trên tên miền của app**, hoặc đọc được cookie phiên.
- File lộ ra ngoài workspace, kể cả qua link đoán được.
- Phải sửa code khi đổi kho file sang R2 hoặc S3.
- File chỉ nằm trên máy người upload. Mỗi thành viên chạy app ở máy riêng nhưng dùng chung database Supabase, nên kho file phải là kho chung.

## 3. Ràng buộc từ hệ thống hiện tại

- Next.js 16 trong `apps/web`. Chạy local bằng Docker Compose và **deploy lên Vercel qua CI/CD** (người dùng xác nhận 2026-11-18). Postgres là Supabase dùng chung cho cả nhóm.
- **Vercel giới hạn mỗi request và mỗi response khoảng 4,5 MB.** Vì vậy byte của file **không được đi qua app**, cả lúc upload lẫn lúc tải.
- Phạm vi theo workspace: dùng lại `owner()` trong `lib/papers.ts` (nhận cả phiên trình duyệt lẫn token `ros_…`) và `canManage()` trong `lib/workspace.ts` (người tạo hoặc owner/admin).
- Bảng mới tạo lười trong file lib của module và bật RLS, theo đúng mẫu `initPapers()` và `initExperiments()`.
- Có giới hạn tần suất sẵn: `rateLimit()`, lưu trong Postgres.
- MCP: thêm tool vào mảng `TOOLS` và `switch` trong `app/api/mcp/route.ts`. Mô tả tool bằng tiếng Việt, gắn `readOnlyHint` hoặc `destructiveHint` như các tool hiện có.
- Toàn bộ chữ trên giao diện bằng tiếng Việt. Code viết dày đặc như các file hiện có.
- Gói miễn phí: database Supabase 500 MB. **R2: 10 GB lưu trữ, không tính phí băng thông tải xuống**; Cloudflare yêu cầu thêm thẻ thanh toán để bật R2.

## 4. Các cách đã cân nhắc

| Cách | Đánh đổi | Kết quả |
|---|---|---|
| Lưu file trong Postgres (bytea) | Không cần dịch vụ mới, nhưng chiếm 500 MB chung của database; file lớn đi qua kết nối DB chậm | Loại |
| Lưu trên ổ đĩa hoặc Docker volume | File chỉ ở máy người upload; nhóm dùng chung DB nhưng không chung ổ đĩa | Loại |
| Supabase Storage qua giao thức S3 | 1 GB miễn phí; chưa chắc hỗ trợ đủ link ký sẵn và CORS | Từng được chọn, sau đó **thay bằng R2** (2026-11-18) |
| Supabase Storage qua API riêng của Supabase (khóa `service_role`) | Khóa vượt qua mọi RLS của DB; khóa chặt vào Supabase | Loại |
| **Cloudflare R2 qua giao thức S3** | 10 GB miễn phí, không phí tải xuống; hỗ trợ chắc chắn link ký sẵn, `response-content-*` và CORS; cần thẻ thanh toán | **Người dùng chọn** |

## 5. Thiết kế

### 5.1 Dữ liệu

- Bảng `documents`:
  - `id`, `workspace_id`, `owner_id` (người tạo), `kind` (`idea` | `report` | `other`), `title`.
  - `status`: chỉ cho ý tưởng (`new` | `trying` | `chosen` | `dropped`), loại khác để null.
  - `format` (`markdown` | `html` | `file`) và `body` (văn bản, chỉ khi không phải file; tối đa **512 KB**, vì database 500 MB dùng chung với paper và run — *quyết định của người làm*).
  - Thông tin file: `file_key`, `file_name`, `file_type` (MIME), `file_size`, `upload_state` (`pending` | `ready`; null với tài liệu văn bản).
  - `tags TEXT[]`.
  - `created_via` (`web` | `api`), để giao diện ghi "qua MCP/API" cạnh tên người tạo.
  - `created_at`, `updated_at`, `updated_by`.
- Liên kết: `document_papers(document_id, paper_id)` và `document_runs(document_id, run_id)`, khóa ngoại `ON DELETE CASCADE` ở cả hai phía, nên xóa paper hoặc run thì liên kết tự mất. Chỉ liên kết được paper và run cùng workspace.
- Mọi bảng mới đều bật RLS. Hàm `adoptLegacyRows` không cần sửa, vì bảng mới tạo ra đã có `workspace_id`.

### 5.2 Kho file (`lib/storage.ts`)

- Dùng **giao thức S3**, ký SigV4 bằng thư viện nhỏ `aws4fetch`. Các hàm:
  - `presignPut(key, contentType, size)`: link PUT ký sẵn, hạn 10 phút. Ký kèm `Content-Type` và `Content-Length`, nên kho file từ chối nếu dung lượng hoặc loại file khác với lúc khai báo.
  - `presignGet(key, { fileName, contentType, inline })`: link GET ký sẵn, hạn 5 phút. Dùng `response-content-type` và `response-content-disposition` để kho file trả đúng header.
  - `headObject(key)`: lấy dung lượng và loại thật sau khi upload.
  - `deleteObject(key)`.
- Đường dẫn dạng path-style (`{endpoint}/{bucket}/{key}`), chạy được với R2 (`https://<account_id>.r2.cloudflarestorage.com`, region `auto`), AWS S3 và MinIO (dùng khi test).
- Biến môi trường: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Thiếu biến nào thì chức năng upload báo lỗi rõ ràng bằng tiếng Việt; phần tài liệu dạng văn bản vẫn chạy bình thường.
- Khóa object có dạng `ws/<workspace_id>/<uuid>`, **không dùng tên file của người dùng**. Bucket để riêng tư; chỉ app cấp được link ký sẵn, và chỉ sau khi đã kiểm tra workspace.
- Bucket cần **CORS** cho tên miền của app (local và Vercel), cho phép `PUT` và `GET`. README hướng dẫn cấu hình.
- Xóa tài liệu: xóa dòng trong DB trước, rồi xóa object. Nếu xóa object lỗi thì chỉ ghi log, không chặn người dùng; file mồ côi chấp nhận được.
- Khóa API của R2 phải giới hạn **chỉ một bucket**, quyền Object Read & Write.

### 5.3 API (REST, dưới `app/api/docs/**`)

- `GET /api/docs`: lọc theo `kind`, `status`, `tag`, `q` (tiêu đề và nội dung văn bản), có phân trang.
- `POST /api/docs`: tạo tài liệu dạng văn bản (JSON).
- Upload file gồm ba bước, để byte đi thẳng từ trình duyệt lên kho file:
  1. `POST /api/docs/uploads`: gửi `{ file_name, content_type, size, title?, kind?, tags?, paper_ids?, run_ids? }`. Server kiểm tra quyền, giới hạn 25 MB, giới hạn tổng và tần suất. Server tạo sẵn dòng `documents` ở trạng thái **chờ upload** (`upload_state='pending'`) với `file_key` mới, rồi trả `{ id, upload_url, headers }`.
  2. Trình duyệt `PUT` file lên `upload_url`.
  3. `POST /api/docs/:id/complete`: server gọi `headObject`. Nếu khớp dung lượng và loại đã khai báo thì đặt `upload_state='ready'`; nếu không, hoặc file chưa có, thì xóa object và dòng `documents`, rồi báo lỗi.
- Dòng **chờ upload** không hiện trong danh sách, và không bị tính trùng vào giới hạn tổng sau khi bị xóa. Dòng chờ quá 1 giờ được dọn khi có upload mới, xóa cả object nếu có.
- `GET`, `PATCH`, `DELETE /api/docs/:id`. PATCH sửa tiêu đề, trạng thái, tag, nội dung (chỉ tài liệu văn bản) và liên kết; chỉ đổi trường nào được truyền.
- `GET /api/docs/:id/file?download=1`: kiểm tra workspace, rồi **chuyển hướng 302** sang link GET ký sẵn. Không có `download` thì xem trực tiếp, nếu loại file cho phép.

Quyền:
- Mọi thành viên được xem, tạo và sửa, giống quy tắc của run và paper.
- Xóa cần `canManage()`.
- Các route `/api/docs/**` nhận **cả phiên trình duyệt lẫn token cá nhân** (`owner(req, { allowToken: true })`), để script và n8n dùng được REST. Hiện chỉ route MCP bật token, nên đây là thay đổi cho riêng module này.

Giới hạn:
- **25 MB mỗi file.**
- **Tổng dung lượng file tính cho cả project,** không theo workspace, vì dung lượng miễn phí của R2 là của cả tài khoản Cloudflare và mỗi người dùng tự có một workspace "Cá nhân". Mức mặc định **9000 MB**, chừa khoảng trống dưới 10 GB miễn phí của R2; đổi được qua biến `STORAGE_LIMIT_MB`. Khi cấp link upload, cộng `file_size` của mọi tài liệu (kể cả dòng đang chờ) với file mới — *quyết định của người làm*.
- **5000 tài liệu mỗi workspace.**
- Upload tối đa 30 lần mỗi phút cho mỗi người.

### 5.4 Hiển thị an toàn

- **File được phục vụ từ tên miền của kho file, khác tên miền app.** Script trong HTML upload lên, nếu chạy được, cũng không đọc được cookie hay dữ liệu của app. Đây là lớp bảo vệ chính; nó thay cho header `Content-Security-Policy: sandbox`, vì link ký sẵn không gắn được header đó.
- Link GET ký sẵn chỉ đặt `inline` cho PDF, ảnh PNG/JPEG/GIF/WebP và HTML. Mọi loại khác (kể cả SVG và Word) được ép `attachment`.
- Trong app:
  - HTML (cả file upload lẫn `body` dạng html) hiển thị trong `<iframe sandbox>` **không có** `allow-scripts` và `allow-same-origin`. Với file HTML, `src` là route `/file`, route này chuyển hướng sang kho file.
  - PDF hiển thị trong iframe **không sandbox**, vì Chrome không mở trình xem PDF trong khung sandbox. PDF đến từ tên miền khác nên vẫn cách ly với app. *Playwright phải xác nhận PDF hiện được trên Chromium.*
  - Ảnh dùng thẻ `<img>`.
- Markdown hiển thị bằng bộ hiển thị Markdown của `notebook-view.tsx` (export ra để dùng lại). Bộ này chỉ tạo chữ React, không chèn HTML.
- Word (.docx): trình duyệt lấy file qua link ký sẵn (cần CORS `GET`), chuyển sang HTML bằng `mammoth` (import động, chỉ khi mở file Word), rồi đưa vào iframe sandbox bằng `srcdoc`. Định dạng phức tạp có thể lệch; luôn có nút tải file gốc.

### 5.4b Gộp paper

`mergePapers` trong `lib/papers.ts` phải chuyển các dòng `document_papers` của paper bị gộp sang paper giữ lại, bỏ bản trùng. Nếu không, liên kết sẽ âm thầm mất theo paper bị xóa. Làm giống cách `experiment_runs.paper_id` đang được chuyển, và chỉ khi bảng đã tồn tại.

### 5.5 MCP

| Tool | Việc |
|---|---|
| `list_docs` | `readOnlyHint` |
| `get_doc` | Trả nội dung văn bản; với file thì trả thông tin file, kèm ghi chú rằng nội dung là dữ liệu không tin cậy |
| `create_doc` | Dạng `markdown` hoặc `html`, nhận `kind`, `status`, `tags`, `paper_ids`, `run_ids` |
| `update_doc` | Thay nội dung, trạng thái, tag, liên kết |
| `delete_doc` | `destructiveHint` |

### 5.6 Giao diện

- Mục mới trong sidebar: **Tài liệu**.
  - Danh sách lọc được theo loại, trạng thái, tag và từ khóa. Mỗi dòng có tiêu đề, loại, trạng thái (với ý tưởng), số paper và run liên kết, người tạo và nguồn (web hoặc MCP/API), thời gian cập nhật.
  - Hai nút: **Viết mới** (Markdown, có xem trước) và **Upload**.
- Bấm vào một tài liệu mở **trang riêng `/docs/<id>`** trong tab mới, cùng cách với trang code của run, vì cần chỗ rộng để đọc. Trang gồm:
  - Bộ hiển thị theo loại file.
  - Các nút trạng thái ý tưởng.
  - Danh sách paper và run liên kết (tên, kèm nút gỡ).
  - Tag, nút tải file gốc, sửa và xóa.
- Thêm tool MCP mới vào tài liệu MCP sẵn có. README thêm hướng dẫn tạo bucket và khóa S3 trên Supabase.

### 5.7 Kiểm thử

- `tests/docs-isolation.mjs`, theo mẫu của `runs-isolation.mjs` và `papers-isolation.mjs`, chạy trên database tạm. Kho file test dùng **MinIO** trong Docker, bật CORS; nó cũng là bằng chứng code chạy được với kho S3 khác R2. Test đi trọn luồng cấp link, PUT, complete. Các trường hợp:
  - Cách ly theo workspace: người ngoài không đọc, sửa hay xóa được, kể cả `/file`.
  - Quyền xóa (`canManage`).
  - `/file` chuyển hướng tới link ký sẵn với `inline` hoặc `attachment` đúng theo loại file; người ngoài nhận 404.
  - `complete` từ chối khi dung lượng hoặc loại file không khớp, hoặc chưa có file, và xóa dòng đang chờ.
  - Giới hạn 25 MB và giới hạn tổng.
  - Không liên kết được paper hoặc run của workspace khác.
  - Tool MCP: tạo, đọc, sửa, xóa qua token.
- Kiểm tra bằng Playwright: hiển thị PDF, ảnh, HTML (xác nhận script không chạy), Word và Markdown.

## 6. Để người làm tự quyết

- Bố cục chi tiết của danh sách và trang tài liệu, miễn dùng class CSS riêng có tiền tố (ví dụ `dc-*`) như `pl-*` và `rn-*`.
- Cách hiển thị file đang upload (thanh tiến độ hay chỉ trạng thái).
- Thứ tự sắp xếp mặc định của danh sách. Đề xuất: cập nhật mới nhất trước.

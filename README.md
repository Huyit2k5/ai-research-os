# AI Research OS — Kaggle Account Manager

Ứng dụng cá nhân quản lý các kết nối Kaggle. Xem [lộ trình Kaggle Connector](docs/KAGGLE_CONNECTOR_ROADMAP.md) và [lộ trình kiến trúc AI Research OS](docs/AI_Research_OS_Architecture_Roadmap.md).

## Chạy bằng Docker Compose

Yêu cầu Docker Desktop và một project Supabase (database PostgreSQL). Nếu chưa có file `.env` ở thư mục gốc, tạo một lần trong PowerShell:

```powershell
node -e "const fs=require('fs'), c=require('crypto'); fs.writeFileSync('.env', 'CREDENTIAL_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64url')+'=\nDATABASE_URL=\n', {flag:'wx'});"
```

Điền `DATABASE_URL` trong `.env`: trên Supabase mở **Connect** → **Session pooler** (hỗ trợ IPv4), copy chuỗi kết nối, thay `[YOUR-PASSWORD]` bằng mật khẩu database và thêm `?sslmode=require&uselibpqcompat=true` vào cuối (xem `.env.example`). Không dùng Direct connection (chỉ IPv6). Docker dùng Session pooler (cổng 5432) vì bước migrate cần advisory lock. **Trên Vercel** thì đặt `DATABASE_URL` là **Transaction pooler** (cùng chuỗi, đổi cổng thành `6543`): Session pooler chỉ cho 15 kết nối, mỗi instance serverless giữ tới 10, nên vài instance là hết và mọi API trả 500 (`max clients reached in session mode`). Sau đó chạy:

```powershell
docker compose up --build -d
```

Khi khởi động, container chạy `scripts/migrate-auth.mjs` để tạo các bảng đăng nhập và `compute_accounts`, đồng thời bật Row Level Security để Data API công khai của Supabase không đọc được. Nếu cổng 3000 bận, đặt `WEB_PORT` trong `.env` và đặt `BETTER_AUTH_URL` cùng cổng đó (ví dụ `http://localhost:3001`), nếu không các thao tác ghi sẽ bị chặn với lỗi "Nguồn yêu cầu không hợp lệ". Giữ lại `.env`: thiếu khóa mã hóa thì không giải mã được token đã lưu. Không chia sẻ hoặc commit file này. Mở http://localhost:3000. Backend dùng Next.js Route Handlers để gọi Kaggle qua HTTP. Dừng bằng `docker compose down`; dữ liệu nằm trên Supabase.

## Đăng nhập

Khi chạy lần đầu, chọn **Tạo tài khoản** để đăng ký bằng email và mật khẩu tối thiểu 12 ký tự. Tài khoản Research OS đầu tiên sẽ tiếp nhận các kết nối Kaggle được tạo trước khi có đăng nhập; hãy tự tạo tài khoản đầu tiên trên máy của bạn. Mỗi tài khoản có sẵn một workspace "Cá nhân". Đăng nhập Research OS độc lập với tài khoản Kaggle.

Ứng dụng dùng Better Auth và lưu phiên trong PostgreSQL. Đăng ký hiện đang mở và chưa có xác minh email. **Quên mật khẩu** gửi link đặt lại (hiệu lực 1 giờ, đặt xong thì đăng xuất mọi phiên) khi đặt `SMTP_URL` và `MAIL_FROM` (xem `.env.example`; với Gmail dùng App password). Không có SMTP thì quản trị viên dùng `node --env-file=.env.local scripts/reset-password.mjs <email>` trong `apps/web`. Bản này chỉ dành cho phát triển cục bộ; trước khi đưa lên mạng cần cấu hình HTTPS, `BETTER_AUTH_URL` đúng tên miền, xác minh email và các biện pháp bảo mật triển khai. Khóa phiên đăng nhập mặc định được dẫn xuất từ `CREDENTIAL_ENCRYPTION_KEY`; giữ nguyên khóa để các phiên còn hiệu lực sau khi khởi động lại.

## Workspace nhóm

Mở **Thành viên** để tạo workspace cho nhóm, chuyển workspace và mời thành viên. Owner hoặc admin nhập email người được mời, app tạo link mời (hết hạn sau 7 ngày); gửi link đó cho họ qua Zalo hoặc chat. Người nhận phải đăng nhập hoặc đăng ký **đúng email được mời** rồi mở link để tham gia.

Thành viên trong workspace cùng thấy danh sách kết nối Kaggle và người tạo từng kết nối. Mọi thành viên đều dùng được kết nối của workspace: kiểm tra, đồng bộ, xem logs, theo dõi trực tiếp và thu run thí nghiệm. Token không bao giờ hiển thị lại, và chỉ người tạo kết nối hoặc owner/admin mới đổi được token hay ngắt kết nối. Kết quả đồng bộ được lưu và cả workspace cùng xem; logs không được lưu.

**Lưu ý trước khi thêm token vào workspace chung:** mọi thành viên sẽ gọi Kaggle bằng danh tính và hạn mức của tài khoản đó (mỗi lần đồng bộ, xem logs hay thu run đều tính vào quota của chủ tài khoản). Chỉ thêm kết nối của tài khoản bạn sẵn sàng chia sẻ với cả nhóm, và đừng dùng để vượt hạn mức Kaggle.

**Thư viện paper**, ghi chú và **run thí nghiệm** cũng dùng chung trong workspace:
- Mọi thành viên xem, thêm và sửa được. Mỗi paper, ghi chú và run hiện tên người đã tạo.
- Chỉ người tạo, hoặc owner/admin, được xóa hay gộp paper và xóa run. Ghi chú chỉ người viết được sửa.
- **Trạng thái đọc** (cần đọc, đang đọc, đã đọc) là của riêng từng người: bạn đánh dấu không ảnh hưởng đồng nghiệp. Mỗi paper hiện số người đã đọc (ví dụ "2/4 đã đọc"), chi tiết paper liệt kê ai đã đọc, và có bộ lọc "Chưa ai đọc" hay "Người khác đã đọc, tôi chưa". Đây là trạng thái tự đánh dấu, không phải bằng chứng đã đọc; hãy viết ghi chú để nhóm biết bạn rút ra gì.
- Paper trùng được nhận diện trong từng workspace, nên cùng một DOI có thể nằm ở hai workspace khác nhau.
- Dữ liệu tạo trước khi có workspace được chuyển vào workspace đầu tiên của người tạo, thường là workspace "Cá nhân".
- Token MCP gắn với workspace đang mở lúc tạo token. Muốn Claude làm việc ở workspace khác, chuyển workspace trên web rồi tạo token mới.

## Đồng bộ Kaggle

Sau khi thêm tài khoản và token, mở **Quota & tài nguyên** và nhấn **Đồng bộ** tại tài khoản mong muốn. Quota GPU/TPU và danh sách notebook được lưu vào database sau mỗi lần đồng bộ và hiển thị lại khi tải trang (lịch sử quota giữ 90 ngày). Hiển thị tối đa 100 notebook đầu cho mỗi tài khoản; nếu còn dữ liệu, giao diện sẽ thông báo.

Trong **Logs & hoạt động**, chọn một notebook đã đồng bộ để lấy logs phiên gần nhất. Nhấn **Theo dõi trực tiếp** để nhận logs từ Kaggle và **Dừng theo dõi** khi hoàn tất; tính khả dụng phụ thuộc phiên notebook và Kaggle. Logs không lưu vào database và giới hạn hiển thị phần cuối. Trạng thái chạy của notebook hiển thị cùng logs và tự cập nhật khi đang chạy; cần kiểm chứng với notebook thật.

Username do người dùng nhập chỉ là nhãn nhận diện, chưa được xác minh với token. Các kết nối được cách ly theo workspace.

Backend sử dụng Next.js; container không cài Python. Các lời gọi Kaggle dựa trên giao thức của SDK chính thức và có thể cần cập nhật nếu Kaggle thay đổi API. Cấu hình phát triển được kiểm tra là Docker Compose.

## Thư viện paper và MCP

Mở mục **Thư viện paper** để tìm paper trên OpenAlex và arXiv (lọc theo khoảng năm, tải thêm tới 10 trang), hoặc thêm trực tiếp bằng DOI / arXiv ID / URL. Paper được lưu theo từng workspace và tự loại trùng theo DOI, arXiv ID, OpenAlex ID, hoặc cùng tiêu đề và năm khi paper không có mã nào. Biến tùy chọn `OPENALEX_API_KEY` (key miễn phí từ openalex.org) nên đặt khi triển khai trên máy chủ dùng chung như Vercel: OpenAlex giới hạn tìm kiếm ẩn danh theo IP nên nếu thiếu key, kết quả có thể chỉ còn từ arXiv (giao diện sẽ báo). `OPENALEX_MAILTO` là email tùy chọn cho OpenAlex; chạy cục bộ không cần đặt biến nào.

Trong thư viện:
- **Trạng thái đọc**: Cần đọc (mặc định) / Đang đọc / Đã đọc.
- **Tag** tự do (tối đa 20 tag mỗi paper, không phân biệt hoa thường khi loại trùng).
- Lọc theo từ khóa, trạng thái, tag, nguồn (tự lưu / từ Claude); sắp xếp theo ngày lưu, năm hoặc tên; tải thêm theo trang 30 paper.
- **Chọn nhiều paper** để đổi trạng thái, gắn hoặc gỡ tag, sao chép BibTeX hoặc xóa cùng lúc.
- **Sửa thông tin paper** (tiêu đề, tác giả, năm, tạp chí/hội nghị, DOI, arXiv, link, abstract) và ghi chú (thêm, sửa, xóa).
- **Số trích dẫn và loại bài** (bài báo, bài hội nghị, preprint...) lấy từ OpenAlex; sắp xếp được theo số trích dẫn.
- **Làm mới metadata** cho một paper hoặc tối đa 100 paper đã chọn: cập nhật số trích dẫn và loại bài, điền các trường còn trống (tạp chí/hội nghị, abstract, DOI...) nhưng không ghi đè dữ liệu đã sửa tay. Paper không tra được theo mã sẽ được tìm theo tiêu đề và chỉ nhận khi tiêu đề khớp chính xác. Tối đa 30 lần mỗi giờ.
- **Tìm và gộp paper trùng** (ví dụ bản preprint và bản tạp chí): chọn bản giữ lại; ghi chú, tag, trạng thái đọc và liên kết experiment run được chuyển sang, các bản còn lại bị xóa.
- **Xuất BibTeX**: tải file `.bib` theo bộ lọc hiện tại hoặc theo các paper đã chọn, hay sao chép BibTeX của một paper. Loại mục là `@inproceedings` / `@article` khi biết hội nghị / tạp chí, còn lại là `@misc` (kèm `eprint` cho arXiv). Tên tác giả không có dấu phẩy được hiểu là “Tên Họ”; với tên tiếng Việt hãy sửa thành “Họ, Tên” để giữ đúng thứ tự.

Giới hạn: tối đa 2.000 paper mỗi tài khoản, 200 ghi chú mỗi paper; tìm kiếm và nhập bằng DOI/arXiv tối đa 20 lần mỗi phút, MCP tối đa 120 lời gọi mỗi phút (đếm trong bảng `api_usage`). Mới lưu metadata và link PDF, chưa lưu file PDF.

API: `GET /api/papers/search?q=&page=&year_from=&year_to=`, `GET /api/papers?q=&sort=newest|year|title|cited&source=manual|mcp&status=to_read|reading|read&tag=&limit=&offset=`, `POST /api/papers`, `POST /api/papers/import` (`{"identifier": "..."}`), `GET|PATCH|DELETE /api/papers/{id}` (PATCH nhận cả `tags` và `read_status`), `GET /api/papers/tags`, `POST /api/papers/refresh` (`{"ids": [...]}`), `GET /api/papers/duplicates`, `POST /api/papers/merge` (`{"keep_id": 1, "merge_ids": [2]}`), `POST /api/papers/bulk` (`{"ids": [...], "action": "delete|status|add_tag|remove_tag", "value": "..."}`), `GET /api/papers/export?ids=` hoặc cùng bộ lọc như danh sách (thêm `inline=1` để trả văn bản), `POST /api/papers/{id}/notes`, `PATCH|DELETE /api/papers/{id}/notes?note_id=`.

MCP server nằm ở `POST /api/mcp` (Streamable HTTP, JSON-RPC). 15 tool cho thư viện paper: `search_papers`, `import_paper`, `save_paper`, `list_papers`, `search_library`, `get_paper`, `update_paper` (gồm tag và trạng thái đọc), `delete_paper`, `list_tags`, `export_bibtex`, `refresh_metadata`, `find_duplicates`, `merge_papers`, `list_notes`, `add_note`; `merge_papers` cũng được đánh dấu phá hủy. `delete_paper` được đánh dấu phá hủy và mô tả yêu cầu Claude chỉ gọi khi người dùng xác nhận. Xác thực bằng token cá nhân tạo ở cuối màn hình Thư viện paper; token chỉ hiện một lần và chỉ lưu bản băm. Thêm vào Claude Code: `claude mcp add --transport http research-os http://localhost:3000/api/mcp --header "Authorization: Bearer <token>"`.

Kiểm thử cách ly dữ liệu, token, MCP, thao tác hàng loạt, xuất BibTeX và giới hạn tần suất: `PAPERS_TEST_BASE=http://localhost:<port> node tests/papers-isolation.mjs` (trong `apps/web`). Mỗi lần chạy tạo hai tài khoản `papers-iso-*@example.test` và không tự xóa, nên nên chạy trên database thử.

## Theo dõi experiment

Mỗi lần chạy notebook Kaggle được lưu thành một run gồm config, metrics, history theo step, trạng thái, môi trường và code. Thêm helper [`docs/ros_tracker.py`](docs/ros_tracker.py) vào notebook (utility script, dataset hoặc dán vào cell đầu) và gọi `log_config`, `log_metric`, `log_summary`, `finish`; helper ghi `/kaggle/working/ros_run.json` và in các dòng `@@ROS_CONFIG` / `@@ROS_METRIC` làm dự phòng. Run được thu khi màn hình Logs thấy notebook chạy xong, khi nhấn **Thu run từ Kaggle**, hoặc khi Claude gọi `capture_run`; chưa có tiến trình chạy nền. Run ở Colab hoặc máy local được ghi thủ công trên giao diện hoặc qua `log_run`. Có thể so sánh 2–10 run và dùng 8 tool MCP cho run. Hướng dẫn đầy đủ và giới hạn: [docs/EXPERIMENT_TRACKING.md](docs/EXPERIMENT_TRACKING.md). Chưa kiểm chứng với notebook thật.

## Chạy notebook từ app (có duyệt)

AI không tự tốn GPU: tool MCP `push_notebook` chỉ **đề xuất** một lần chạy (code, notebook đích hoặc notebook mới, máy T4×2/L4/TPU/CPU, ý tưởng liên quan). Yêu cầu hiện ở **Thí nghiệm → Chờ duyệt** (sidebar có số đếm). Thành viên mở **Xem code** (code, so sánh với version hiện tại trên Kaggle, log), rồi **Duyệt & chạy** hoặc **Từ chối** kèm ghi chú để AI sửa (`get_run_request` đọc được ghi chú). Chỉ duyệt được trên web, không có tool hay token nào duyệt được.

Khi duyệt, app gửi code lên Kaggle bằng kết nối của workspace (`SaveKernel`, Save & Run All). Cấu hình không ghi rõ được giữ như version hiện tại, kể cả dataset (Kaggle xóa dataset nếu không gửi lại). Hết quota GPU thì không gửi. Đang chạy thì trang yêu cầu có log trực tiếp; chạy xong, run được thu vào Thí nghiệm và gắn vào ý tưởng (ý tưởng Mới chuyển sang Đang thử khi duyệt). Trạng thái chỉ cập nhật khi có người mở tab **Đang chạy**/trang yêu cầu, hoặc AI gọi `get_run_request`.

**Lưu, không chạy (Quick Save):** người duyệt bấm nút này, hoặc AI gửi `run: false`, thì app lưu code thành version mới trên Kaggle mà không chạy cell nào (trạng thái **Đã lưu**, không tốn quota, không thu run). **Giới hạn thời gian chạy:** chọn trong hộp Chạy hoặc AI gửi `timeout_minutes` (1–720); Kaggle tự dừng khi hết giờ. Để trống thì không đặt giới hạn riêng, chỉ còn giới hạn phiên của Kaggle.

Người cũng chạy trực tiếp được: nút **Chạy ▶** ở Notebooks (chạy lại code version hiện tại) và **Chạy lại version này** ở trang code của run. Yêu cầu chờ quá 7 ngày hết hạn; tối đa 50 yêu cầu chờ mỗi workspace.

## Tài liệu (ý tưởng, kết quả, báo cáo, file)

Mục **Tài liệu** là chỗ chung của workspace cho ý tưởng, báo cáo và file. Mỗi tài liệu có loại **Ý tưởng** (trạng thái Mới → Đang thử → Đã chọn / Bỏ), **Báo cáo** hoặc **Khác**, và liên kết được tới paper và run trong cùng workspace. Bấm vào tài liệu để mở ở tab mới.

- **Viết mới:** Markdown hoặc HTML, có xem trước.
- **Upload:** HTML, PDF, Word, ảnh… tối đa 25 MB. PDF, ảnh, HTML và Word xem được ngay trên web; loại khác tải về. HTML luôn hiển thị trong khung cách ly không chạy script.
- **Danh mục:** cột bên trái màn Tài liệu; nhóm tự tạo, đổi tên, xóa (tối đa 50). Xóa danh mục thì tài liệu trong đó về "Chưa phân loại".
- **Kết quả thực nghiệm:** loại **Kết quả** gồm tối đa 10 run và phần kết luận; mở ra là thấy bảng so sánh metric, config khác nhau và biểu đồ, luôn theo số liệu mới nhất. Tạo bằng nút **Lưu thành kết quả** ở màn so sánh run, **Tạo kết quả từ các run** ở trang ý tưởng, hoặc AI gọi `create_doc` với `kind: "result"` và `run_ids`.
- **AI viết qua MCP:** các tool `list_docs`, `get_doc`, `create_doc`, `update_doc`, `delete_doc` (cùng token cá nhân như các tool paper và run). Script hoặc n8n dùng REST `/api/docs` với `Authorization: Bearer <token>`.

### Cấu hình kho file (Cloudflare R2)

File không đi qua app: trình duyệt upload thẳng lên kho bằng link ký sẵn, nên VPS nhỏ không phải gánh file lớn.

1. Cloudflare dashboard → **R2 Object Storage** (cần thêm thẻ thanh toán để bật R2, kể cả gói miễn phí 10 GB) → tạo bucket.
2. **Overview → Account Details → API Tokens → Manage → Create Account API token**: quyền **Object Read & Write**, chỉ áp dụng cho bucket vừa tạo. Copy **Access Key ID** và **Secret Access Key** (secret chỉ hiện một lần).
3. Bucket → **Settings → CORS Policy**, thêm mọi địa chỉ mở app (local và URL triển khai, đúng `https://…`, không có `/` cuối):
   ```json
   [{ "AllowedOrigins": ["http://localhost:3001", "https://<ten-may>.<tailnet>.ts.net"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["content-type"], "ExposeHeaders": ["content-type", "content-disposition", "content-length"], "MaxAgeSeconds": 3600 }]
   ```
4. Điền `S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` vào `.env` (Docker) và `apps/web/.env.local` (`npm run dev`).
5. Kiểm tra: `cd apps/web && node --env-file=.env.local scripts/storage-check.mjs --origin <địa chỉ app>`. Cả 6 dòng phải ✓.

Đổi sang dịch vụ S3 khác (AWS S3, MinIO…) chỉ cần đổi 5 biến trên. `STORAGE_LIMIT_MB` (mặc định 9000) giới hạn tổng dung lượng file của cả project.


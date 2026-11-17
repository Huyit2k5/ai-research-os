# AI Research OS — Kaggle Account Manager

Ứng dụng cá nhân quản lý các kết nối Kaggle. Xem [lộ trình Kaggle Connector](docs/KAGGLE_CONNECTOR_ROADMAP.md) và [lộ trình kiến trúc AI Research OS](docs/AI_Research_OS_Architecture_Roadmap.md).

## Chạy bằng Docker Compose

Yêu cầu Docker Desktop và một project Supabase (database PostgreSQL). Nếu chưa có file `.env` ở thư mục gốc, tạo một lần trong PowerShell:

```powershell
node -e "const fs=require('fs'), c=require('crypto'); fs.writeFileSync('.env', 'CREDENTIAL_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64url')+'=\nDATABASE_URL=\n', {flag:'wx'});"
```

Điền `DATABASE_URL` trong `.env`: trên Supabase mở **Connect** → **Session pooler** (hỗ trợ IPv4), copy chuỗi kết nối, thay `[YOUR-PASSWORD]` bằng mật khẩu database và thêm `?sslmode=require&uselibpqcompat=true` vào cuối (xem `.env.example`). Không dùng Direct connection (chỉ IPv6) hoặc Transaction pooler (cổng 6543). Sau đó chạy:

```powershell
docker compose up --build -d
```

Khi khởi động, container chạy `scripts/migrate-auth.mjs` để tạo các bảng đăng nhập và `compute_accounts`, đồng thời bật Row Level Security để Data API công khai của Supabase không đọc được. Nếu cổng 3000 bận, đặt `WEB_PORT` trong `.env` và đặt `BETTER_AUTH_URL` cùng cổng đó (ví dụ `http://localhost:3001`), nếu không các thao tác ghi sẽ bị chặn với lỗi "Nguồn yêu cầu không hợp lệ". Giữ lại `.env`: thiếu khóa mã hóa thì không giải mã được token đã lưu. Không chia sẻ hoặc commit file này. Mở http://localhost:3000. Backend dùng Next.js Route Handlers để gọi Kaggle qua HTTP. Dừng bằng `docker compose down`; dữ liệu nằm trên Supabase.

## Đăng nhập

Khi chạy lần đầu, chọn **Tạo tài khoản** để đăng ký bằng email và mật khẩu tối thiểu 12 ký tự. Tài khoản Research OS đầu tiên sẽ tiếp nhận các kết nối Kaggle được tạo trước khi có đăng nhập; hãy tự tạo tài khoản đầu tiên trên máy của bạn. Mỗi tài khoản có sẵn một workspace "Cá nhân". Đăng nhập Research OS độc lập với tài khoản Kaggle.

Ứng dụng dùng Better Auth và lưu phiên trong PostgreSQL. Đăng ký hiện đang mở và chưa có xác minh email hoặc khôi phục mật khẩu. Bản này chỉ dành cho phát triển cục bộ; trước khi đưa lên mạng cần cấu hình HTTPS, `BETTER_AUTH_URL` đúng tên miền, xác minh email, khôi phục mật khẩu và các biện pháp bảo mật triển khai. Khóa phiên đăng nhập mặc định được dẫn xuất từ `CREDENTIAL_ENCRYPTION_KEY`; giữ nguyên khóa để các phiên còn hiệu lực sau khi khởi động lại.

## Workspace nhóm

Mở **Thành viên** để tạo workspace cho nhóm, chuyển workspace và mời thành viên. Owner hoặc admin nhập email người được mời, app tạo link mời (hết hạn sau 7 ngày); gửi link đó cho họ qua Zalo hoặc chat. Người nhận phải đăng nhập hoặc đăng ký **đúng email được mời** rồi mở link để tham gia.

Thành viên trong workspace cùng thấy danh sách kết nối Kaggle và người tạo từng kết nối. Chỉ người tạo kết nối mới dùng được token của kết nối đó: đồng bộ, kiểm tra, lấy logs, theo dõi trực tiếp, đổi token. Kết quả đồng bộ và logs chưa được lưu để chia sẻ; chỉ người đồng bộ thấy trong phiên của mình. Owner và admin được xóa kết nối của thành viên khác nhưng không dùng được token của họ.

## Đồng bộ Kaggle

Sau khi thêm tài khoản và token, mở **Quota & tài nguyên** và nhấn **Đồng bộ** tại tài khoản mong muốn. Quota GPU/TPU và danh sách notebook được lấy từ Kaggle, hiển thị trong phiên trình duyệt và cần đồng bộ lại khi tải lại trang. Hiển thị tối đa 100 notebook đầu cho mỗi tài khoản; nếu còn dữ liệu, giao diện sẽ thông báo.

Trong **Logs & hoạt động**, chọn một notebook đã đồng bộ để lấy logs phiên gần nhất. Nhấn **Theo dõi trực tiếp** để nhận logs từ Kaggle và **Dừng theo dõi** khi hoàn tất; tính khả dụng phụ thuộc phiên notebook và Kaggle. Logs không lưu vào database và giới hạn hiển thị phần cuối. Trạng thái chạy chưa được tích hợp.

Username do người dùng nhập chỉ là nhãn nhận diện, chưa được xác minh với token. Các kết nối được cách ly theo workspace.

Backend sử dụng Next.js; container không cài Python. Các lời gọi Kaggle dựa trên giao thức của SDK chính thức và có thể cần cập nhật nếu Kaggle thay đổi API. Cấu hình phát triển được kiểm tra là Docker Compose.

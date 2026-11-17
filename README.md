# AI Research OS — Kaggle Account Manager

Ứng dụng cá nhân quản lý các kết nối Kaggle. Xem [lộ trình Kaggle Connector](docs/KAGGLE_CONNECTOR_ROADMAP.md) và [lộ trình kiến trúc AI Research OS](docs/AI_Research_OS_Architecture_Roadmap.md).

## Chạy bằng Docker Compose

Yêu cầu Docker Desktop. Nếu chưa có file `.env` ở thư mục gốc, tạo một lần trong PowerShell:

```powershell
node -e "const fs=require('fs'), c=require('crypto'); fs.writeFileSync('.env', 'CREDENTIAL_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64url')+'=\nPOSTGRES_PASSWORD='+c.randomBytes(24).toString('hex')+'\n', {flag:'wx'});"
docker compose up --build -d
```

Giữ lại `.env`: khóa mã hóa và mật khẩu database cần thiết để sử dụng lại dữ liệu. Không chia sẻ hoặc commit file này. Mở http://localhost:3000. Backend dùng Next.js Route Handlers để gọi Kaggle qua HTTP. Dừng bằng `docker compose down`; dữ liệu PostgreSQL vẫn được giữ trong volume. Không thêm `-v` nếu muốn giữ dữ liệu.

## Đăng nhập

Khi chạy lần đầu, chọn **Tạo tài khoản** để đăng ký bằng email và mật khẩu tối thiểu 12 ký tự. Tài khoản Research OS đầu tiên sẽ tiếp nhận các kết nối Kaggle được tạo trước khi có đăng nhập; hãy tự tạo tài khoản đầu tiên trên máy của bạn. Các tài khoản đăng ký sau chỉ nhìn thấy kết nối của chính mình. Đăng nhập Research OS độc lập với tài khoản Kaggle.

Ứng dụng dùng Better Auth và lưu phiên trong PostgreSQL. Đăng ký hiện đang mở và chưa có xác minh email, khôi phục mật khẩu, mời thành viên hoặc phân quyền workspace. Bản này chỉ dành cho phát triển cục bộ; trước khi đưa lên mạng cần cấu hình HTTPS, `BETTER_AUTH_URL` đúng tên miền, xác minh email, khôi phục mật khẩu và các biện pháp bảo mật triển khai. Khóa phiên đăng nhập mặc định được dẫn xuất từ `CREDENTIAL_ENCRYPTION_KEY`; giữ nguyên khóa để các phiên còn hiệu lực sau khi khởi động lại.

## Đồng bộ Kaggle

Sau khi thêm tài khoản và token, mở **Quota & tài nguyên** và nhấn **Đồng bộ** tại tài khoản mong muốn. Quota GPU/TPU và danh sách notebook được lấy từ Kaggle, hiển thị trong phiên trình duyệt và cần đồng bộ lại khi tải lại trang. Hiển thị tối đa 100 notebook đầu cho mỗi tài khoản; nếu còn dữ liệu, giao diện sẽ thông báo.

Trong **Logs & hoạt động**, chọn một notebook đã đồng bộ để lấy logs phiên gần nhất. Nhấn **Theo dõi trực tiếp** để nhận logs từ Kaggle và **Dừng theo dõi** khi hoàn tất; tính khả dụng phụ thuộc phiên notebook và Kaggle. Logs không lưu vào database và giới hạn hiển thị phần cuối. Trạng thái chạy chưa được tích hợp.

Username do người dùng nhập chỉ là nhãn nhận diện, chưa được xác minh với token. Các kết nối được cách ly theo tài khoản Research OS; chia sẻ dữ liệu trong workspace chưa được triển khai.

Backend sử dụng Next.js; container không cài Python. Các lời gọi Kaggle dựa trên giao thức của SDK chính thức và có thể cần cập nhật nếu Kaggle thay đổi API. Cấu hình phát triển được kiểm tra là Docker Compose.

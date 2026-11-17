# AI Research OS — Kaggle Account Manager

Ứng dụng cá nhân quản lý các kết nối Kaggle. Xem [lộ trình Kaggle Connector](docs/KAGGLE_CONNECTOR_ROADMAP.md) và [lộ trình kiến trúc AI Research OS](docs/AI_Research_OS_Architecture_Roadmap.md).

## Chạy bằng Docker Compose

Yêu cầu Docker Desktop. Nếu chưa có file `.env` ở thư mục gốc, tạo một lần trong PowerShell:

```powershell
node -e "const fs=require('fs'), c=require('crypto'); fs.writeFileSync('.env', 'CREDENTIAL_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64url')+'=\nPOSTGRES_PASSWORD='+c.randomBytes(24).toString('hex')+'\n', {flag:'wx'});"
docker compose up --build -d
```

Giữ lại `.env`: khóa mã hóa và mật khẩu database cần thiết để sử dụng lại dữ liệu. Không chia sẻ hoặc commit file này. Mở http://localhost:3000. Backend dùng Next.js Route Handlers để gọi Kaggle qua HTTP. Dừng bằng `docker compose down`; dữ liệu PostgreSQL vẫn được giữ trong volume. Không thêm `-v` nếu muốn giữ dữ liệu.

## Đồng bộ Kaggle

Sau khi thêm tài khoản và token, mở **Quota & tài nguyên** và nhấn **Đồng bộ** tại tài khoản mong muốn. Quota GPU/TPU và danh sách notebook được lấy từ Kaggle, hiển thị trong phiên trình duyệt và cần đồng bộ lại khi tải lại trang. Hiển thị tối đa 100 notebook đầu cho mỗi tài khoản; nếu còn dữ liệu, giao diện sẽ thông báo.

Trong **Logs & hoạt động**, chọn một notebook đã đồng bộ để lấy logs phiên gần nhất. Nhấn **Theo dõi trực tiếp** để nhận logs từ Kaggle và **Dừng theo dõi** khi hoàn tất; tính khả dụng phụ thuộc phiên notebook và Kaggle. Logs không lưu vào database và giới hạn hiển thị phần cuối. Trạng thái chạy chưa được tích hợp.

Username do người dùng nhập chỉ là nhãn nhận diện, chưa được xác minh với token. Ứng dụng hiện chỉ dành cho một người dùng cục bộ; chưa có đăng nhập và phân quyền, không đưa API ra mạng công cộng.

Backend sử dụng Next.js; container không cài Python. Các lời gọi Kaggle dựa trên giao thức của SDK chính thức và có thể cần cập nhật nếu Kaggle thay đổi API. Cấu hình phát triển được kiểm tra là Docker Compose.

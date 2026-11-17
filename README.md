# AI Research OS — Kaggle Account Manager

Ứng dụng cá nhân quản lý các kết nối Kaggle. Xem [lộ trình](KAGGLE_CONNECTOR_ROADMAP.md).

## Chạy bằng Docker Compose

Yêu cầu Docker Desktop. Nếu chưa có file `.env` ở thư mục gốc, tạo một lần trong PowerShell:

```powershell
python -m pip install cryptography
python -c "import secrets; from cryptography.fernet import Fernet; from pathlib import Path; p=Path('.env'); assert not p.exists(), '.env đã tồn tại'; p.write_text('CREDENTIAL_ENCRYPTION_KEY='+Fernet.generate_key().decode()+'\nPOSTGRES_PASSWORD='+secrets.token_hex(24)+'\n', encoding='utf-8')"
docker compose up --build -d
```

Giữ lại `.env`: khóa mã hóa và mật khẩu database cần thiết để sử dụng lại dữ liệu. Không chia sẻ hoặc commit file này. Mở http://localhost:3000. Backend là Next.js Route Handlers; Kaggle CLI chạy trong cùng container. Dừng bằng `docker compose down`; dữ liệu PostgreSQL vẫn được giữ trong volume. Không thêm `-v` nếu muốn giữ dữ liệu.

## Đồng bộ Kaggle

Sau khi thêm tài khoản và token, mở **Quota & tài nguyên** và nhấn **Đồng bộ** tại tài khoản mong muốn. Quota GPU/TPU và danh sách notebook được lấy từ Kaggle, hiển thị trong phiên trình duyệt và cần đồng bộ lại khi tải lại trang. Hiển thị tối đa 200 notebook đầu cho mỗi tài khoản; nếu còn dữ liệu, giao diện sẽ thông báo.

Trong **Logs & hoạt động**, chọn một notebook đã đồng bộ để lấy logs phiên gần nhất. Nhấn **Theo dõi trực tiếp** để nhận logs từ Kaggle và **Dừng theo dõi** khi hoàn tất; tính khả dụng phụ thuộc phiên notebook và Kaggle. Logs không lưu vào database và giới hạn hiển thị phần cuối. Trạng thái chạy chưa được tích hợp.

Username do người dùng nhập chỉ là nhãn nhận diện, chưa được xác minh với token. Ứng dụng hiện chỉ dành cho một người dùng cục bộ; chưa có đăng nhập và phân quyền, không đưa API ra mạng công cộng.

Mã FastAPI cũ được giữ trong `apps/api` để tham khảo nhưng không còn chạy trong Docker Compose. Hiện cấu hình phát triển được kiểm tra là Docker Compose.

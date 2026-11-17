# Lộ trình triển khai Kaggle Account Manager

Mục tiêu: xây dựng ứng dụng cá nhân quản lý các kết nối Kaggle được ủy quyền; mở rộng dần thành AI Research OS. Giao diện sáng, Next.js; backend FastAPI, lưu credential mã hóa. Các số liệu trên giao diện chỉ hiển thị khi đồng bộ được từ Kaggle.

## 1. Nền tảng và kiểm chứng
- [x] Tạo cấu trúc dự án, cấu hình môi trường, tài liệu chạy và API.
- [x] Tách adapter Kaggle, xác thực bằng API token qua tiến trình CLI riêng cho từng tài khoản.
- [ ] Kiểm chứng quota, notebook và logs với tài khoản thật và phiên bản CLI đã cài. Các tính năng chưa xác minh không được trình bày là đã hoạt động.

## 2. Giao diện sáng
- [x] Dashboard responsive, trạng thái trống và lỗi, biểu mẫu kết nối, kiểm tra và ngắt kết nối.
- [ ] Bổ sung màn hình notebook và các trạng thái đồng bộ sau khi xác minh API.

## 3. Kết nối tài khoản thật
- [x] API thêm, liệt kê, kiểm tra, thay credential và xóa kết nối; mã hóa credential server-side, không trả về client.
- [x] Lưu dữ liệu bền vững, cấu hình SQLite cho phát triển cục bộ và PostgreSQL qua DATABASE_URL.
- [ ] Kiểm thử với token Kaggle thật; xác minh phân tách nhiều tài khoản.
- [ ] Trước khi triển khai cho nhiều người: đăng nhập, phân quyền workspace, secret manager và migrations.

## 4. Đồng bộ và hoàn thiện
- [ ] Tích hợp quota, danh sách notebook, trạng thái và logs theo khả năng CLI đã xác minh.
- [ ] Đồng bộ định kỳ, retry, giới hạn request và thông báo lỗi.
- [ ] Kiểm thử end-to-end với Kaggle; sau đó thêm MLflow, biểu đồ và thông báo.

## Tiêu chí hoàn thành MVP
Thêm tài khoản thật, kiểm tra, thay credential, ngắt kết nối; xem quota và ít nhất một notebook thật khi Kaggle hỗ trợ; xử lý lỗi rõ ràng. Không sử dụng kết nối để vượt hạn mức Kaggle. Thời gian tham khảo 13–19 ngày làm việc; điều chỉnh theo kết quả kiểm chứng.

# Lộ trình triển khai Kaggle Account Manager

Mục tiêu: xây dựng ứng dụng cá nhân quản lý kết nối Kaggle của chính người dùng; mở rộng dần thành AI Research OS. Giao diện và API dùng Next.js, lưu credential mã hóa. Các số liệu trên giao diện chỉ hiển thị khi đồng bộ được từ Kaggle.

## 1. Nền tảng và kiểm chứng
- [x] Tạo cấu trúc dự án, cấu hình môi trường, tài liệu chạy và API.
- [x] Tách adapter Kaggle, xác thực bằng API token qua tiến trình CLI riêng cho từng tài khoản.
- [x] Kiểm chứng quota và danh sách notebook với tài khoản thật và phiên bản CLI đã cài.
- [x] Kiểm chứng lấy logs với notebook thật.
- [ ] Kiểm chứng trạng thái chạy với notebook thật.

## 2. Giao diện sáng
- [x] Dashboard responsive, trạng thái trống và lỗi, biểu mẫu kết nối, kiểm tra và ngắt kết nối.
- [ ] Bổ sung màn hình notebook và các trạng thái đồng bộ sau khi xác minh API.

## 3. Kết nối tài khoản thật
- [x] API thêm, liệt kê, kiểm tra, thay credential và xóa kết nối; mã hóa credential server-side, không trả về client.
- [x] Lưu dữ liệu bền vững, cấu hình SQLite cho phát triển cục bộ và PostgreSQL qua DATABASE_URL.
- [ ] Kiểm thử với token Kaggle thật; xác minh phân tách nhiều tài khoản.
- [ ] Trước khi triển khai cho nhiều người: đăng nhập, phân quyền workspace, secret manager và migrations.

## 4. Đồng bộ và hoàn thiện
- [x] Đồng bộ thủ công quota và danh sách notebook trong phiên trình duyệt.
- [x] Xem và làm mới logs notebook thủ công.
- [x] Triển khai luồng logs trực tiếp qua Kaggle CLI; cần kiểm chứng với notebook đang chạy.
- [ ] Tích hợp trạng thái chạy và lưu dữ liệu đồng bộ bền vững.
- [ ] Đồng bộ định kỳ, retry, giới hạn request và thông báo lỗi.
- [ ] Kiểm thử end-to-end với Kaggle; sau đó thêm MLflow, biểu đồ và thông báo.

## Tiêu chí hoàn thành MVP
Thêm tài khoản thật, kiểm tra, thay credential, ngắt kết nối; xem quota và ít nhất một notebook thật khi Kaggle hỗ trợ; xử lý lỗi rõ ràng. Không sử dụng kết nối để vượt hạn mức Kaggle. Thời gian tham khảo 13–19 ngày làm việc; điều chỉnh theo kết quả kiểm chứng.

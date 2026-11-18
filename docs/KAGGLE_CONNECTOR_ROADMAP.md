# Lộ trình triển khai Kaggle Account Manager

Mục tiêu: xây dựng ứng dụng cá nhân quản lý kết nối Kaggle của chính người dùng; mở rộng dần thành AI Research OS. Giao diện và API dùng Next.js, lưu credential mã hóa. Các số liệu trên giao diện chỉ hiển thị khi đồng bộ được từ Kaggle.

## 1. Nền tảng và kiểm chứng
- [x] Tạo cấu trúc dự án, cấu hình môi trường, tài liệu chạy và API.
- [x] Xác thực từng tài khoản bằng API token và gọi Kaggle qua HTTP.
- [x] Kiểm chứng quota và danh sách notebook với tài khoản thật.
- [x] Kiểm chứng lấy logs với notebook thật.
- [ ] Kiểm chứng trạng thái chạy với notebook thật.

## 2. Giao diện sáng
- [x] Dashboard responsive, trạng thái trống và lỗi, biểu mẫu kết nối, kiểm tra và ngắt kết nối.
- [x] Bổ sung màn hình notebook và các trạng thái đồng bộ.

## 3. Kết nối tài khoản thật
- [x] API thêm, liệt kê, kiểm tra, thay credential và xóa kết nối; mã hóa credential server-side, không trả về client.
- [x] Lưu dữ liệu bền vững, PostgreSQL trên Supabase qua DATABASE_URL.
- [ ] Kiểm thử với token Kaggle thật; xác minh phân tách nhiều tài khoản.
- [x] Đăng ký, đăng nhập và cách ly các kết nối Kaggle theo từng người dùng.
- [x] Workspace nhóm: mời thành viên bằng link theo email, cùng thấy danh sách kết nối; mọi thành viên dùng được kết nối; chỉ người tạo hoặc owner/admin đổi token và ngắt kết nối.
- [ ] Trước khi triển khai cho nhiều người: xác minh email, khôi phục mật khẩu, secret manager và migrations có phiên bản.

## 4. Đồng bộ và hoàn thiện
- [x] Đồng bộ thủ công quota và danh sách notebook trong phiên trình duyệt.
- [x] Xem và làm mới logs notebook thủ công.
- [x] Triển khai luồng logs trực tiếp qua API Kaggle; cần kiểm chứng với notebook đang chạy.
- [x] Lưu quota và notebook đã đồng bộ vào database (lịch sử quota 90 ngày).
- [x] Hiển thị trạng thái chạy notebook (GetKernelSessionStatus, tự cập nhật 10 giây khi đang chạy); cần kiểm chứng với notebook thật.
- [x] Theo dõi experiment: thu run từ output notebook (`ros_run.json` hoặc dòng `@@ROS_CONFIG` / `@@ROS_METRIC` trong log), kèm môi trường và code từ GetKernel (best-effort); tự thu khi trạng thái notebook kết thúc, thu thủ công theo version.
- [x] Helper `docs/ros_tracker.py` cho notebook và hướng dẫn `docs/EXPERIMENT_TRACKING.md`.
- [x] Run thủ công (Colab, máy local), sửa tên/ghi chú/tag/paper liên kết, so sánh 2–10 run.
- [x] Tool MCP cho run: `list_compute_accounts`, `list_runs`, `get_run`, `compare_runs`, `capture_run`, `log_run`, `update_run`, `delete_run`.
- [ ] Kiểm chứng thu run với notebook Kaggle thật (file output, dòng log khi crash, môi trường và code từ GetKernel).
- [x] Chạy notebook từ app có duyệt: AI đề xuất qua MCP `push_notebook`, thành viên duyệt trên web, app gửi `SaveKernel` (giữ dataset/GPU của version hiện tại), log trực tiếp, thu run và gắn vào ý tưởng; nút Chạy ở Notebooks và Chạy lại ở trang code run.
- [ ] Kiểm chứng GPU (`machineShape` NvidiaTeslaT4) và trọn vòng duyệt → chạy → thu run với notebook thật.
- [ ] Đồng bộ định kỳ, retry, giới hạn request và thông báo lỗi.
- [ ] Kiểm thử end-to-end với Kaggle; sau đó thêm MLflow, biểu đồ và thông báo.

## 5. Tài liệu nghiên cứu
- [x] Ý tưởng, báo cáo và file dùng chung theo workspace; liên kết paper và run; trạng thái ý tưởng.
- [x] Upload HTML, PDF, Word, ảnh lên Cloudflare R2 qua link ký sẵn; xem an toàn trên web.
- [x] Tool MCP và REST cho AI và script viết tài liệu.

## Tiêu chí hoàn thành MVP
Thêm tài khoản thật, kiểm tra, thay credential, ngắt kết nối; xem quota và ít nhất một notebook thật khi Kaggle hỗ trợ; xử lý lỗi rõ ràng. Không sử dụng kết nối để vượt hạn mức Kaggle. Thời gian tham khảo 13–19 ngày làm việc; điều chỉnh theo kết quả kiểm chứng.

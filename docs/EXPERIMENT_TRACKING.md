# Theo dõi experiment (experiment runs)

Research OS lưu mỗi lần chạy notebook thành một **run**: config (siêu tham số), metrics, history theo step, trạng thái, môi trường và bản chụp code. Run Kaggle được thu từ output của notebook; run ở nơi khác (Colab, máy local) được ghi thủ công. Dữ liệu được cách ly theo tài khoản Research OS như kết nối Kaggle và thư viện paper.

## Thông tin nào được ghi

**Tự động, không cần sửa notebook** (lấy từ API Kaggle):
- Notebook (`owner/notebook`), số version, tên run (`<tiêu đề> v<version>`), thời điểm chạy.
- Trạng thái (`complete`, `error`, `cancel_acknowledged`...) và thông báo lỗi nếu có.
- Môi trường: ngôn ngữ, loại kernel, accelerator (GPU/TPU), bật internet hay không, dataset / competition / model / notebook được gắn làm input.
- Code của notebook và mã băm SHA-256 của nó.

Môi trường và code lấy từ API `GetKernel` của Kaggle và chỉ là **best-effort**: định dạng phản hồi chưa được kiểm chứng với mọi loại notebook, và code chỉ khớp với **version mới nhất** (thu một version cũ sẽ không có code).

**Cần helper `ros_tracker.py`** (hoặc tự ghi đúng định dạng bên dưới):
- Config: learning rate, batch size, kiến trúc model, seed...
- Metrics cuối cùng (giá trị mới nhất của từng metric) và history theo step để vẽ đường cong.

Không có helper, run vẫn được tạo nhưng chỉ có trạng thái, môi trường và code.

## Cài đặt trên Kaggle

1. Lấy file [`docs/ros_tracker.py`](ros_tracker.py) (một file, chỉ dùng thư viện chuẩn, Python 3.8 trở lên).
2. Đưa vào notebook theo **một** trong ba cách:
   - **Utility script** (khuyên dùng): trên Kaggle tạo notebook mới, dán nội dung file, đặt tên `ros_tracker`, vào **File → Set as utility script** rồi **Save Version**. Trong notebook huấn luyện chọn **File → Add utility script** và chọn script đó. Sau đó `from ros_tracker import ...` dùng được ngay.
   - **Dataset**: tải `ros_tracker.py` lên một dataset, gắn dataset vào notebook rồi thêm `import sys; sys.path.append("/kaggle/input/<tên-dataset>")` trước khi import.
   - **Dán vào cell đầu tiên** của notebook rồi chạy cell đó. Khi dán vào cell, phần demo cuối file không chạy, và các hàm được dùng trực tiếp (không cần `import`).
3. Gọi `log_config(...)` một lần ở đầu, `log_metric(step=..., ...)` trong vòng lặp, `log_summary(...)` cho kết quả cuối và `finish()` ở cuối notebook.
4. Chạy notebook bằng **Save Version → Save & Run All (Commit)** để Kaggle giữ lại output. Phiên chạy tương tác (Draft) không tạo version nên không có output để thu.

Ví dụ (kiểu PyTorch):

```python
from ros_tracker import log_config, log_metric, log_summary, finish

cfg = {"model": {"name": "resnet18", "pretrained": True}, "optim": {"name": "adamw", "lr": 3e-4, "weight_decay": 0.05}, "batch_size": 128, "epochs": 20, "seed": 42}
log_config(cfg)

for epoch in range(cfg["epochs"]):
    train_loss = train_one_epoch(model, train_loader, optimizer)   # hàm của bạn
    val_loss, val_acc = evaluate(model, val_loader)
    log_metric(step=epoch, train_loss=train_loss, val_loss=val_loss, val_acc=val_acc)

log_summary(test_acc=evaluate(model, test_loader)[1])
finish()
```

Tham số của helper:
- `log_config(dict)` hoặc `log_config(key=value, ...)`: gộp vào config. Config lồng nhau được server làm phẳng thành khóa dạng `optim.lr` (tối đa 3 cấp). Nhận cả `argparse.Namespace`.
- `log_metric(step=None, metrics=None, **metrics)`: giá trị phải là số. Tensor 1 phần tử và số numpy được chuyển bằng `.item()` / `float()`; NaN, inf và giá trị không phải số bị bỏ qua kèm một cảnh báo. Có `step` thì điểm được thêm vào history. Tên metric có ký tự đặc biệt dùng dict: `log_metric(epoch, {"val/acc": acc})`.
- `log_summary(...)`: metric cuối không có step, ví dụ `test_acc`.
- `finish()`: ghi file ngay. Helper cũng tự ghi khi Python thoát, nhưng nên gọi `finish()` ở cell cuối.

Lưu ý:
- Huấn luyện nhiều GPU (DDP): chỉ gọi helper ở rank 0, nếu không mỗi tiến trình sẽ ghi đè cùng một file và in trùng log.
- Log Kaggle bị cắt bớt khi quá dài, và mỗi lần `log_metric` in một dòng. Hãy log theo epoch hoặc mỗi N step thay vì mỗi batch.
- Helper không bao giờ dừng vòng lặp huấn luyện vì lỗi ghi file: nó chỉ cảnh báo một lần và vẫn in metrics ra log.

## Định dạng dữ liệu

Helper ghi ra hai nơi; có thể tự ghi theo đúng định dạng này mà không cần helper.

1. File **`/kaggle/working/ros_run.json`** (Kaggle giữ các file trong `/kaggle/working` làm output của version):

   ```json
   {"config": {"optim": {"lr": 0.0003}, "batch_size": 128},
    "metrics": {"val_acc": 0.912, "test_acc": 0.905},
    "history": [{"step": 0, "train_loss": 1.83, "val_acc": 0.41}, {"step": 1, "train_loss": 1.12, "val_acc": 0.63}]}
   ```

   `metrics` là giá trị mới nhất của từng metric, `history` là mọi điểm có `step`. Helper ghi file nguyên tử (file tạm rồi đổi tên), tối đa mỗi 5 giây một lần, cộng với lần đầu, `finish()` và khi thoát. Ngoài Kaggle, file được ghi vào `$ROS_OUTPUT_DIR` hoặc thư mục hiện tại.

2. **Dòng log**, mỗi dòng một object JSON trên **một dòng**:

   ```
   @@ROS_CONFIG {"optim":{"lr":0.0003},"batch_size":128}
   @@ROS_METRIC {"step":1,"train_loss":1.12,"val_acc":0.63}
   ```

   Server dùng các dòng này khi không có file (notebook crash trước khi ghi), và để bổ sung config còn thiếu trong file. Khi có cả hai, metrics và history trong file được ưu tiên.

## Khi nào run được thu

Hiện **chưa có tiến trình chạy nền**; run chỉ được thu khi có một trong ba việc sau:

1. **Màn hình Logs & hoạt động** đang mở notebook và thấy trạng thái chuyển sang kết thúc (`complete`, `error` hoặc `cancel_acknowledged`): run được thu tự động. Trong vòng 2 phút sau một lần thu, notebook đó không được thu lại tự động.
2. Nhấn nút **Thu run từ Kaggle** trên màn hình **Thí nghiệm**, chọn tài khoản và nhập `owner/notebook` (để trống version để lấy lần chạy mới nhất, notebook phải chạy xong).
3. Nhờ Claude gọi tool MCP **`capture_run`** (dùng `list_compute_accounts` để lấy `account_id`).

Nếu không ai mở ứng dụng khi notebook chạy xong, run **không bị mất**: output vẫn nằm trên Kaggle và sẽ được thu ở lần sau. Version cũ được thu bằng cách nhập số version. Thu lại cùng một version sẽ cập nhật run cũ (không tạo bản trùng) và giữ nguyên tên, ghi chú, tag và paper liên kết mà bạn đã sửa; nếu lần thu sau không đọc được dữ liệu thì config và metrics cũ được giữ lại.

## Run thủ công (Colab, máy local)

Với run không chạy trên tài khoản Kaggle đã kết nối:
- Trên màn hình **Thí nghiệm**, chọn ghi run thủ công và nhập tên, config, metrics, trạng thái, nền tảng (ví dụ Colab).
- Hoặc kể kết quả cho Claude để nó gọi tool **`log_run`** (nhận cả `config`, `metrics`, `history`, `notes`, `tags`, `paper_id`).

Có thể chạy `ros_tracker.py` ở Colab/local (đặt `ROS_OUTPUT_DIR` nếu muốn) rồi dùng nội dung `ros_run.json` làm config / metrics / history cho run thủ công. Config và metrics của run thủ công sửa được; của run Kaggle thì không, vì chúng được thu tự động.

## Dùng chung trong workspace

Run thuộc về **workspace**, không thuộc riêng một người:
- Mọi thành viên trong workspace đều xem, so sánh, đổi tên, ghi chú, gắn tag và liên kết paper cho run. Mỗi run hiện tên người đã tạo.
- Run Kaggle nằm trong workspace của kết nối Kaggle đã dùng để thu. Chỉ **người tạo kết nối** mới thu được run từ kết nối đó, vì chỉ họ được dùng token.
- Chỉ người tạo run, hoặc owner/admin của workspace, mới xóa được run.
- Paper liên kết với run phải nằm trong cùng workspace.
- Token MCP gắn với workspace đang mở lúc tạo token. Muốn Claude làm việc ở workspace khác, hãy chuyển workspace trên web rồi tạo token mới.

## So sánh run

Chọn 2 đến 10 run để xem cạnh nhau:
- **Config khác nhau** giữa các run, và phần config giống nhau được gom riêng.
- **Từng metric** của mỗi run, đánh dấu run tốt nhất. Metric có tên chứa `loss`, `err`, `mae`, `mse`, `rmse`, `perplexity`, `wer`, `fid`, `latency`, `time`... được coi là càng thấp càng tốt; còn lại càng cao càng tốt.

Mỗi run có thể đổi tên, ghi chú, gắn tag và liên kết với một paper trong thư viện. Danh sách lọc được theo từ khóa, notebook, tag, trạng thái, nguồn và sắp xếp theo một metric.

API: `GET /api/runs?q=&ref=&tag=&status=&source=kaggle|manual&sort=newest|oldest|metric&metric=&order=asc|desc&limit=&offset=`, `POST /api/runs` (run thủ công), `GET|PATCH|DELETE /api/runs/{id}` (`?code=1` để lấy code), `POST /api/runs/capture` (`{"account_id": 1, "ref": "owner/notebook", "version": 3}`), `GET /api/runs/compare?ids=1,2,3`.

## Tool MCP cho Claude

| Tool | Việc làm |
| --- | --- |
| `list_compute_accounts` | Liệt kê tài khoản Kaggle đã kết nối (không trả credential) để lấy `account_id`. |
| `list_runs` | Liệt kê run, lọc và sắp xếp theo metric. |
| `get_run` | Xem đầy đủ một run (history dài được lấy mẫu; `include_code` để lấy code). |
| `compare_runs` | So sánh 2–10 run. |
| `capture_run` | Thu run từ output Kaggle (mới nhất hoặc theo version). |
| `log_run` | Ghi run thủ công. |
| `update_run` | Sửa tên, ghi chú, tag, paper liên kết (config/metrics chỉ với run thủ công). |
| `delete_run` | Xóa vĩnh viễn một run; chỉ dùng khi người dùng xác nhận. |

Cách thêm MCP server vào Claude Code xem phần **Thư viện paper và MCP** trong [README](../README.md).

## Giới hạn

- Tối đa **10.000 run** mỗi workspace.
- History giữ **5.000 điểm** cuối; file `ros_run.json` tải tối đa **2 MB** (lớn hơn thì bỏ qua file và dùng dòng log nếu có).
- Config tối đa **200 khóa** (sau khi làm phẳng, lồng tối đa 3 cấp; giá trị chuỗi cắt ở 1.000 ký tự); metrics tối đa **100 khóa**, chỉ nhận số hữu hạn.
- Log Kaggle bị cắt khi quá dài nên phương án dự phòng bằng dòng log có thể thiếu phần đầu hoặc cuối: in metrics thưa và luôn để helper ghi file.
- Thu run qua REST tối đa 20 lần mỗi phút; tool MCP tính chung giới hạn 120 lời gọi mỗi phút.
- Chưa kiểm chứng với notebook Kaggle thật.

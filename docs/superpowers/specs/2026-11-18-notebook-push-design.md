# Chạy notebook Kaggle từ app, có duyệt — thiết kế

Ngày: 2026-11-18 · Trạng thái: đã duyệt (2026-11-18)

## 1. Mục đích

Mục tiêu của AI Research OS là tự động hóa quy trình nghiên cứu: con người chỉ theo dõi kết quả, **xem code** và chọn ý tưởng.

Hiện app chỉ *đọc* từ Kaggle (quota, notebook, log, thu run). Muốn train vẫn phải mở Kaggle bấm tay, nên vòng *ý tưởng → code → chạy → kết quả* bị đứt ở bước chạy, và run thu về không tự gắn với ý tưởng nào.

Module này cho phép:
- **AI** (qua MCP/REST, token cá nhân) **đề xuất** một lần chạy: code, notebook đích, cấu hình máy, ý tưởng liên quan. App chỉ lưu lại, **chưa** gửi sang Kaggle.
- **Người** xem code trên web rồi **Duyệt & chạy** hoặc **Từ chối kèm ghi chú**. Duyệt thì app gửi code lên Kaggle bằng kết nối chung của workspace (token không rời server) và Kaggle chạy.
- Khi chạy xong, run được thu như hiện nay và **tự gắn vào ý tưởng**.
- Người tự bấm **Chạy** trên web (notebook có sẵn, hoặc chạy lại code của một run) thì không cần duyệt thêm.

## 2. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu**
- Yêu cầu chạy (run request) có vòng đời: `pending → approved → running → done | failed`, hoặc `pending → rejected | cancelled | expired`.
- Duyệt **chỉ** qua phiên đăng nhập web. Không có tool MCP hay route nhận token nào duyệt được. AI không tự duyệt được, kể cả dùng token của người duyệt.
- Người duyệt thấy toàn bộ code (render dạng notebook như trang code của run) và **diff so với version hiện tại** trên Kaggle.
- Ghi chú từ chối đọc được qua MCP để AI sửa và gửi lại.
- Run thu được từ một yêu cầu tự vào `document_runs` của ý tưởng; ý tưởng đang `new` chuyển sang `trying` khi yêu cầu được duyệt.
- Chặn trước khi tốn GPU: kiểm tra quota GPU còn lại của tài khoản ngay lúc duyệt.

**Không làm (bản này)**
- Sửa code trên web. Muốn đổi thì từ chối kèm ghi chú.
- Theo dõi nền / cron. Trạng thái chỉ cập nhật khi có người mở tab, hoặc AI gọi `get_run_request`. Vercel Cron để sau.
- Thông báo email/Discord khi có yêu cầu mới hoặc run xong.
- Hủy phiên đang chạy trên Kaggle, xóa notebook.
- Dataset upload, chạy trên Colab/máy khác.

**Phản mục tiêu (làm vậy là hỏng dù chạy được)**
- Bất kỳ đường nào khiến code chưa được người duyệt mà vẫn tốn GPU.
- Token Kaggle lộ ra client, MCP hay log.
- Ghi đè dataset/GPU/internet của notebook có sẵn thành rỗng chỉ vì AI không gửi các trường đó.

## 3. Các cách đã cân nhắc

- **A. Hàng chờ duyệt trong app (đã chọn).** Yêu cầu lưu trong Postgres; duyệt trên web mới gọi `SaveKernel`. Dấu vết ai duyệt/từ chối, gắn ý tưởng được, review ngay trong app.
- **B. AI `QuickSave` lên Kaggle, người bấm chạy sau.** Ít code hơn nhưng làm rác lịch sử version Kaggle, review ngoài app, vẫn phải gửi lại code khi chạy.
- **C. Duyệt qua GitHub PR.** Quá nặng cho nhóm 3 người, lệch khỏi app.

Người dùng chọn A.

## 4. Kaggle API

`kaggleCall(token, "SaveKernel", body)` (cùng wire protocol với SDK chính thức). Các trường dùng tới, đã đối chiếu với schema của Kaggle MCP:

| Trường | Ý nghĩa |
|---|---|
| `slug` | `owner/kernel-slug` của notebook có sẵn; notebook mới thì bỏ trống và dùng `newTitle` |
| `newTitle` | tiêu đề (bắt buộc khi tạo mới) |
| `text` | nội dung: JSON `.ipynb` (kernelType `notebook`) hoặc mã `.py` (`script`) |
| `language` | `python` |
| `kernelType` | `notebook` \| `script` |
| `isPrivate` | mặc định `true` |
| `enableGpu`, `enableInternet` | boolean |
| `machineShape` | `NvidiaTeslaT4` (T4 ×2), `NvidiaL4`, `TpuV5E8`; rỗng = CPU |
| `datasetDataSources`, `competitionDataSources`, `kernelDataSources`, `modelDataSources` | nguồn dữ liệu |
| `kernelExecutionType` | `SaveAndRunAll` (luôn dùng giá trị này) |

Phản hồi mong đợi: `ref`, `url`, `versionNumber`, `error`, `invalid*`. **Chưa kiểm chứng với tài khoản thật**: bước đầu tiên của plan là một lần gọi thật để xác nhận tên trường, định dạng `slug`, cách bật GPU (`enableGpu` + `machineShape`) và việc bỏ trống danh sách nguồn có xóa nguồn cũ không.

**Kế thừa cấu hình:** với notebook có sẵn, app gọi `GetKernel` lấy metadata version hiện tại. Trường nào yêu cầu không ghi rõ thì lấy từ metadata đó (nguồn dữ liệu, GPU, internet, private, kernelType). Không bao giờ gửi danh sách nguồn rỗng thay cho "không đổi".

## 5. Dữ liệu

Bảng mới `run_requests` (tạo lười trong `lib/run-requests.ts`, RLS bật, giống `lib/experiments.ts`):

```
id SERIAL PK
workspace_id TEXT NOT NULL
account_id INTEGER REFERENCES compute_accounts(id) ON DELETE CASCADE
ref TEXT                -- owner/slug; NULL khi tạo notebook mới cho tới lúc chạy
new_title TEXT          -- chỉ khi tạo mới
kernel_type TEXT        -- notebook | script
code TEXT NOT NULL      -- ≤ 2 MB
settings JSONB          -- { machine_shape, enable_internet, is_private, dataset_sources, ... } chỉ các trường được ghi rõ
summary TEXT            -- AI mô tả thay đổi, ≤ 4000 ký tự, hiện cho người duyệt
idea_id INTEGER REFERENCES documents(id) ON DELETE SET NULL
status TEXT             -- pending | approved | running | done | failed | rejected | cancelled | expired
requested_by TEXT       -- user id (chủ token hoặc người bấm)
requested_via TEXT      -- mcp | api | web
reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT (≤ 2000)
version INTEGER         -- versionNumber Kaggle trả về khi chạy
run_id INTEGER REFERENCES experiment_runs(id) ON DELETE SET NULL
error TEXT
created_at, updated_at TIMESTAMPTZ
```

- `idea_id` phải là tài liệu `kind='idea'` cùng workspace.
- `account_id` phải thuộc workspace; `ref` (nếu có) phải có owner trùng username của kết nối hoặc tồn tại trong danh sách notebook đã đồng bộ của kết nối đó.
- Yêu cầu `pending` quá 7 ngày chuyển `expired` (quét lười khi liệt kê, như sweep của tài liệu).
- Giới hạn: 50 yêu cầu `pending` mỗi workspace; tạo yêu cầu 30/giờ mỗi người; duyệt 10/phút mỗi người.

## 6. Luồng

**AI đề xuất** — `push_notebook` (MCP) / `POST /api/run-requests` (token hoặc phiên):
validate → lưu `pending` → trả `{id, status, review_url}`. Không gọi Kaggle.
Gửi qua phiên web cũng tạo `pending` ở route này; nút "Chạy" trên UI dùng route khác (dưới).

**Người duyệt** — `POST /api/run-requests/:id/approve` (**chỉ phiên**, kiểm CSRF như mọi route ghi):
1. Giành quyền bằng một câu lệnh: `UPDATE … SET status='approved' WHERE id=$1 AND status='pending' RETURNING …`. Không trả về dòng nào → 409 (đã có người duyệt/từ chối). Không giữ transaction trong lúc gọi Kaggle.
2. Lấy quota GPU mới (`GetAcceleratorQuotaStatistics`) nếu cấu hình dùng GPU/TPU; hết thì đặt lại `pending` + `error`, báo người duyệt.
3. `GetKernel` (notebook có sẵn) để kế thừa cấu hình → `SaveKernel` `SaveAndRunAll`.
4. Thành công: `running`, lưu `version`, `ref` (khi tạo mới), `reviewed_by/at`, xóa `error`; ý tưởng `new → trying`.
   Lỗi ở bước 2–3 (Kaggle từ chối, mạng): chưa có gì chạy, nên đặt lại `pending` + `error` để duyệt lại được. `failed` chỉ dành cho phiên Kaggle đã chạy và lỗi.

**Từ chối** — `POST /api/run-requests/:id/reject {note}` (chỉ phiên). **Hủy** — người tạo hủy được yêu cầu `pending` của chính mình (phiên, hoặc token qua `cancel_run_request`).

**Người tự chạy** — `POST /api/run-requests/run-now` (chỉ phiên): `{account_id, ref}` chạy lại code version hiện tại (GetKernel), hoặc `{run_id}` chạy lại `experiment_runs.code` của run đó trên notebook của nó. Tạo dòng `requested_via='web'` rồi đi thẳng bước 2–4 (người bấm = người duyệt).

**Theo dõi & thu run** — dòng `running` được cập nhật khi:
- tab "Chờ duyệt / Đang chạy" mở: mỗi 30 giây gọi `GET /api/run-requests/:id/status`, hoặc
- AI gọi `get_run_request`.
Route này dùng lại `GetKernelSessionStatus` + `captureRun(…, {version})`. Kết thúc → `done`/`failed`, lưu `run_id`, chèn `document_runs (idea_id, run_id) ON CONFLICT DO NOTHING`.
Đường `notebook-status` hiện có (màn Logs) cũng gọi cùng hàm "khớp yêu cầu" sau khi thu run, để run thu từ đó cũng gắn ý tưởng.

## 7. Giao diện

- **Thí nghiệm** thêm tab **"Chờ duyệt (n)"** và **"Đang chạy"**; sidebar hiện số yêu cầu chờ duyệt cạnh "Thí nghiệm".
  ```
  Chờ duyệt (2)
  ┌──────────────────────────────────────────────────────────┐
  │ lora-rank-sweep · thinh/lora-exp · T4×2 · ý tưởng #12    │
  │ AI qua token của Thịnh · 5 phút trước                    │
  │ "Tăng rank 8→16, thêm warmup"                            │
  │ [Xem code]  [Duyệt & chạy]  [Từ chối…]                   │
  └──────────────────────────────────────────────────────────┘
  ```
- **Trang xem yêu cầu** `/run-requests/[id]` (tab mới, giống `/runs/[id]/code`): tóm tắt, cấu hình máy, ý tưởng, code render bằng `notebook-view`, tab **Diff** so với code version hiện tại trên Kaggle (diff theo dòng, chỉ cell code), nút Duyệt/Từ chối.
- **Log trực tiếp**: yêu cầu đang `running` (trong tab "Đang chạy" và trên trang yêu cầu) có khung **Log** theo dõi trực tiếp qua `notebook-logs-stream` sẵn có (cùng token của kết nối, chỉ phiên mới nhất); khi đã kết thúc thì hiện bản chụp log của đúng `version` qua `notebook-logs?ref=owner/slug/<version>`. Phần đọc luồng SSE tách khỏi `logs-screen.tsx` thành một component dùng chung, không viết lại.
- **Notebooks**: mỗi notebook có nút **Chạy** → hộp nhỏ (máy: T4×2 / L4 / CPU, internet, ý tưởng tùy chọn) → `run-now` → chuyển sang Logs với notebook đó.
- **Trang code của run**: nút **Chạy lại version này**.
- **Tài liệu (ý tưởng)**: danh sách run đã có sẵn; thêm dòng các yêu cầu chạy đang chờ/đang chạy của ý tưởng.

## 8. MCP

Thêm 4 tool (tổng 32):
- `push_notebook` — tạo yêu cầu `pending`. Tham số: `account_id`, `ref` hoặc `new_title`, `code`, `kernel_type?`, `machine?` (`t4x2|l4|tpu|cpu`), `enable_internet?`, `dataset_sources?`…, `idea_id?`, `summary`. Mô tả tool nói rõ: *không chạy ngay; người phải duyệt trên web*. Gợi ý dùng `docs/ros_tracker.py` để có metric.
- `list_run_requests` — lọc `status`, `idea_id`.
- `get_run_request` — gồm `review_note`, `version`, `run_id`; nếu đang `running` thì cập nhật trạng thái như mục 6.
- `cancel_run_request` — chỉ yêu cầu `pending` do chính người đó tạo; `destructiveHint`.

## 9. Quyền

- Tạo yêu cầu, xem, liệt kê: mọi thành viên workspace (phiên hoặc token).
- Duyệt, từ chối, chạy ngay: mọi thành viên, **chỉ qua phiên**. Người tạo yêu cầu cũng tự duyệt được trên web (nhóm nhỏ; điểm mấu chốt là phải có người bấm trên web).
- Hủy: người tạo, hoặc owner/admin (`canManage`).

## 10. Kiểm thử

- `tests/run-requests-isolation.mjs` (DB dùng một lần): cách ly workspace, token không duyệt được (403 trên approve/reject/run-now), CSRF, validate (idea khác workspace, idea không phải kind idea, code quá lớn, máy không hợp lệ), giới hạn pending, hủy chỉ của mình, hết hạn 7 ngày, MCP 4 tool.
- Không mock Kaggle: test dùng kết nối có token giả, nên duyệt sẽ tới bước gọi Kaggle và nhận lỗi; test kiểm tra yêu cầu quay về `pending` kèm `error` (chứng minh đã qua mọi kiểm tra quyền), như `runs-isolation` đang dừng ở bước gọi Kaggle.
- Một lần chạy thật với tài khoản Kaggle của nhóm (notebook nhỏ, CPU) trước khi merge.

## 11. Các quyết định do Claude đề xuất (người dùng kiểm tra khi duyệt)

- Người gửi yêu cầu (qua AI) được tự duyệt trên web.
- Notebook mới mặc định chạy CPU nếu AI không ghi máy; notebook có sẵn kế thừa cấu hình hiện tại.
- Hết hạn 7 ngày; 50 yêu cầu chờ mỗi workspace; 30 yêu cầu/giờ mỗi người; code ≤ 2 MB.
- Không theo dõi nền; trạng thái chạy cập nhật khi có người mở tab hoặc AI hỏi.
- Người duyệt không sửa code trên web.

## 12. Để lại cho người làm

- Thuật toán diff (thư viện `diff` hay tự viết LCS ngắn).
- Bố cục chi tiết các tab/hộp thoại, theo style `rn-*` sẵn có.
- Thứ tự commit.

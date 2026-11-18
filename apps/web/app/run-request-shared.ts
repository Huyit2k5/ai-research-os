export type RunRequest = {
  id: number;
  account_id: number;
  account_label: string;
  ref: string | null;
  new_title: string | null;
  kernel_type: string;
  settings: {
    machine?: string;
    enable_internet?: boolean;
    is_private?: boolean;
    dataset_sources?: string[];
    competition_sources?: string[];
    kernel_sources?: string[];
    model_sources?: string[];
  };
  summary: string;
  idea_id: number | null;
  idea_title: string | null;
  status: string;
  requested_by_name: string | null;
  requested_via: "mcp" | "api" | "web";
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  version: number | null;
  run_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  mine: boolean;
  can_cancel: boolean;
  code?: string;
};

export const REQUEST_STATUS: Record<string, string> = {
  pending: "Chờ duyệt",
  approved: "Đang gửi",
  running: "Đang chạy",
  done: "Xong",
  failed: "Lỗi",
  rejected: "Đã từ chối",
  cancelled: "Đã hủy",
  expired: "Hết hạn",
};
export const MACHINE_LABEL: Record<string, string> = { t4x2: "GPU T4 ×2", l4: "GPU L4", tpu: "TPU v5e-8", cpu: "CPU" };
export const machineOf = (r: Pick<RunRequest, "settings" | "ref">) =>
  r.settings.machine ? (MACHINE_LABEL[r.settings.machine] ?? r.settings.machine) : r.ref ? "Giữ như hiện tại" : "CPU";
/** Settings a reviewer must notice before approving: making the notebook public, internet, data attached. */
export const settingNotes = (r: Pick<RunRequest, "settings">) =>
  [
    r.settings.is_private === false ? "⚠ Công khai" : "",
    r.settings.enable_internet ? "internet" : "",
    ...(["dataset_sources", "competition_sources", "kernel_sources", "model_sources"] as const).flatMap(
      (k) => r.settings[k] ?? [],
    ),
  ].filter(Boolean);
export const VIA_LABEL: Record<string, string> = { mcp: "AI qua MCP", api: "API", web: "Web" };
export const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1
    ? "vừa xong"
    : m < 60
      ? `${m} phút trước`
      : m < 1440
        ? `${Math.round(m / 60)} giờ trước`
        : `${Math.round(m / 1440)} ngày trước`;
};

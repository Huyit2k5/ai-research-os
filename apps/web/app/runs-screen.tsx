"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type SetStateAction } from "react";
import { ArrowUpDown, CloudDownload, Code2, Columns3, Copy, ExternalLink, GitCompareArrows, Pencil, Plus, Search, Tag, TestTubes, Trash2, Trophy, X } from "lucide-react";
import type { Account, SyncData } from "./connector-screens";

type Scalar = string | number | boolean | null;
type Run = { id: number; account_id: number | null; source: "kaggle" | "manual"; ref: string | null; version: number | null; name: string; status: string; failure_message: string; config: Record<string, Scalar>; metrics: Record<string, number>; env: Record<string, unknown>; captured_from: string; notes: string; tags: string[]; paper_id: number | null; run_at: string | null; captured_at: string; created_at: string; history_points: number; created_by?: string | null; can_delete?: boolean };
type Point = { step?: number } & Record<string, number | undefined>;
type RunDetail = Run & { history?: Point[]; code_hash?: string | null; code?: string | null };
type Page = { total: number; offset: number; limit: number; items: Run[] };
type CompareRun = Pick<Run, "id" | "name" | "source" | "ref" | "version" | "status" | "run_at" | "env" | "tags">;
type Compare = { runs: CompareRun[]; config_diff: { key: string; values: unknown[] }[]; config_same: { key: string; value: unknown }[]; metrics: { key: string; better: "lower" | "higher"; values: (number | null)[]; best_index: number | null }[] };
type PaperLite = { id: number; title: string; year: number | null };
type Series = { name: string; color: string; points: { x: number; y: number }[] };

const PAGE = 50, MAX_COMPARE = 10, MAX_METRIC_COLS = 5, MAX_CONFIG_COLS = 3;
const STATUS: Record<string, string> = { queued: "Đang chờ", running: "Đang chạy", complete: "Hoàn tất", error: "Lỗi", cancel_requested: "Đang hủy", cancel_acknowledged: "Đã hủy", unknown: "Không rõ" };
const CAPTURED: Record<string, string> = { run_json: "Từ file ros_run.json", log: "Từ dòng @@ROS trong log", none: "Không tìm thấy dữ liệu, chỉ có thông tin Kaggle", manual: "Nhập thủ công" };
const ENV_LABEL: Record<string, string> = { platform: "Nền tảng", title: "Tiêu đề notebook", language: "Ngôn ngữ", kernel_type: "Loại kernel", accelerator: "Phần cứng", enable_internet: "Internet", datasets: "Dataset", competitions: "Cuộc thi", kernels: "Notebook nguồn", models: "Model", last_run_time: "Lần chạy (Kaggle)" };
/** Categorical slots in fixed order (validated: adjacent CVD ΔE ≥ 9.1 on white). Never cycled: series past 8 are not drawn. */
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const LOWER_BETTER = /(loss|err|error|mae|mse|rmse|mape|perplexity|ppl|wer|cer|fid|latency|time|duration)/i;
const REF = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const SNIPPET = `from ros_tracker import log_config, log_metric
log_config(model="vit-b16", lr=3e-4, batch_size=64, seed=42)
log_metric(step=epoch, train_loss=loss, val_acc=acc)`;

async function call<T>(path: string, method = "GET", body?: object): Promise<T> {
  const res = await fetch(path, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Thao tác không thành công.");
  return data as T;
}
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const lowerBetter = (k: string) => LOWER_BETTER.test(k);
/** Compact number: 4–5 significant digits, exponent for very large/small values. */
function fmt(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return n.toExponential(2);
  return Number.isInteger(n) ? n.toLocaleString("en-US").replace(/,/g, " ") : String(Number(n.toPrecision(5)));
}
const show = (v: unknown) => v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v);
const when = (s: string | null) => s ? new Date(s).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "—";
/** Keys ordered by how many runs have them, then alphabetically. */
function keysByFrequency(objs: Record<string, unknown>[]) {
  const c = new Map<string, number>(); for (const o of objs) for (const k of Object.keys(o)) c.set(k, (c.get(k) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]);
}
function pointsOf(history: Point[] | undefined, key: string) {
  return (history ?? []).flatMap((p, i) => typeof p[key] === "number" && Number.isFinite(p[key]) ? [{ x: typeof p.step === "number" ? p.step : i + 1, y: p[key] as number }] : []).sort((a, b) => a.x - b.x);
}
const historyKeys = (hs: (Point[] | undefined)[]) => keysByFrequency(hs.flatMap(h => h ?? []).map(p => { const { step: _s, ...rest } = p; void _s; return rest; }));
function parseScalar(v: string): Scalar {
  const t = v.trim();
  if (t === "true" || t === "false") return t === "true";
  if (t === "null") return null;
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return v;
}

// ---- Chart ----
function niceScale(min: number, max: number, count: number) {
  if (min === max) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
  const raw = (max - min) / Math.max(count, 1), mag = 10 ** Math.floor(Math.log10(raw)), e = raw / mag, step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, ticks };
}
function useWidth() {
  const ref = useRef<HTMLDivElement>(null); const [w, setW] = useState(0);
  useEffect(() => { const el = ref.current; if (!el) return; setW(Math.floor(el.getBoundingClientRect().width)); const ro = new ResizeObserver(e => setW(Math.floor(e[0].contentRect.width))); ro.observe(el); return () => ro.disconnect(); }, []);
  return [ref, w] as const;
}
function nearest(points: { x: number; y: number }[], x: number) {
  let lo = 0, hi = points.length - 1; if (hi < 0) return null;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].x < x) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(points[lo - 1].x - x) <= Math.abs(points[lo].x - x) ? points[lo - 1] : points[lo];
}

/** Line chart in inline SVG: one y axis, crosshair + tooltip with every series, legend and direct end labels, table view. */
function LineChart({ series, metric, xLabel, empty }: { series: Series[]; metric: string; xLabel: string; empty: string }) {
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const drawn = series.filter(s => s.points.length > 0);
  const xs = [...new Set(drawn.flatMap(s => s.points.map(p => p.x)))].sort((a, b) => a - b);
  const H = 260, labels = drawn.length >= 2 && drawn.length <= 4 && width >= 480;
  const M = { l: 58, r: labels ? 104 : 18, t: 14, b: 42 }, pw = Math.max(width - M.l - M.r, 10), ph = H - M.t - M.b;
  let yMin = Infinity, yMax = -Infinity; for (const s of drawn) for (const p of s.points) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
  const yS = niceScale(drawn.length ? yMin : 0, drawn.length ? yMax : 1, 5), xS = niceScale(xs[0] ?? 0, xs[xs.length - 1] ?? 1, Math.max(2, Math.floor(pw / 90)));
  const xMin = xs.length > 1 ? xs[0] : xS.lo, xMax = xs.length > 1 ? xs[xs.length - 1] : xS.hi;
  const sx = (x: number) => M.l + (xMax === xMin ? pw / 2 : (x - xMin) / (xMax - xMin) * pw), sy = (y: number) => M.t + ph - (y - yS.lo) / (yS.hi - yS.lo) * ph;
  const xTicks = xS.ticks.filter(t => t >= xMin && t <= xMax);
  if (!drawn.length) return <div ref={wrap} className="rn-chart"><div className="rn-chart-empty">{empty}</div></div>;
  // Direct labels: last point of each series, pushed apart vertically so they never overlap.
  const ends = labels ? drawn.map(s => ({ s, y: sy(s.points[s.points.length - 1].y) })).sort((a, b) => a.y - b.y) : [];
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const hx = hover === null || hover >= xs.length ? null : xs[hover];
  const rows = hx === null ? [] : drawn.map(s => ({ s, p: nearest(s.points, hx) }));
  function move(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect(), x = xMin + (e.clientX - box.left) / box.width * (xMax - xMin);
    let best = 0; for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    setHover(best);
  }
  function key(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    setHover(h => e.key === "Home" ? 0 : e.key === "End" ? xs.length - 1 : Math.min(Math.max((h ?? xs.length - 1) + (e.key === "ArrowLeft" ? -1 : 1), 0), xs.length - 1));
  }
  const tipLeft = hx === null ? 0 : sx(hx) + 14 > width - 190 ? Math.max(sx(hx) - 190, 0) : sx(hx) + 14;
  const tableRows = xs.slice(-300), maps = drawn.map(s => new Map(s.points.map(p => [p.x, p.y])));
  return <div ref={wrap} className="rn-chart">
    {drawn.length >= 2 && <div className="rn-legend">{drawn.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>}
    <div className="rn-chart-box">
      {width > 0 && <svg width={width} height={H} role="img" tabIndex={0} aria-label={`Biểu đồ ${metric} theo ${xLabel}, ${drawn.length} đường. Dùng phím mũi tên để xem giá trị.`} onKeyDown={key} onFocus={() => setHover(h => h ?? xs.length - 1)} onBlur={() => setHover(null)}>
        {yS.ticks.map(t => <g key={`y${t}`}><line x1={M.l} x2={M.l + pw} y1={sy(t)} y2={sy(t)} className="rn-grid" /><text x={M.l - 8} y={sy(t)} dy="0.32em" textAnchor="end" className="rn-tick">{fmt(t)}</text></g>)}
        <line x1={M.l} x2={M.l + pw} y1={M.t + ph} y2={M.t + ph} className="rn-axis" />
        {xTicks.map(t => <text key={`x${t}`} x={sx(t)} y={M.t + ph + 16} textAnchor="middle" className="rn-tick">{fmt(t)}</text>)}
        <text x={M.l + pw / 2} y={H - 6} textAnchor="middle" className="rn-axis-label">{xLabel}</text>
        <text transform={`translate(13 ${M.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="rn-axis-label">{metric}</text>
        {drawn.map(s => s.points.length === 1 ? <circle key={s.name} cx={sx(s.points[0].x)} cy={sy(s.points[0].y)} r={4} fill={s.color} /> : <path key={s.name} d={s.points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join("")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {ends.map(({ s, y }) => <text key={`l${s.name}`} x={M.l + pw + 8} y={y} dy="0.32em" className="rn-direct">{s.name.length > 15 ? `${s.name.slice(0, 14)}…` : s.name}</text>)}
        {hx !== null && <g pointerEvents="none"><line x1={sx(hx)} x2={sx(hx)} y1={M.t} y2={M.t + ph} className="rn-cross" />{rows.map(({ s, p }) => p && <circle key={s.name} cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />)}</g>}
        <rect x={M.l} y={M.t} width={pw} height={ph} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
      </svg>}
      {hx !== null && <div className="rn-tip" style={{ left: tipLeft }}><div className="rn-tip-x">{xLabel} {fmt(hx)}</div>{rows.map(({ s, p }) => <div key={s.name} className="rn-tip-row"><i style={{ background: s.color }} /><b>{p ? fmt(p.y) : "—"}</b><span>{s.name}{p && p.x !== hx ? ` (${xLabel.toLowerCase()} ${fmt(p.x)})` : ""}</span></div>)}</div>}
    </div>
    <details className="rn-chart-table"><summary>Xem dạng bảng</summary><div className="rn-scroll"><table><thead><tr><th>{xLabel}</th>{drawn.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead><tbody>{tableRows.map(x => <tr key={x}><td>{fmt(x)}</td>{maps.map((m, i) => <td key={i}>{fmt(m.get(x))}</td>)}</tr>)}</tbody></table></div>{xs.length > tableRows.length && <p className="rn-muted">Chỉ hiển thị {tableRows.length} điểm cuối trong {xs.length} điểm.</p>}</details>
  </div>;
}

// ---- Small pieces ----
function StatusBadge({ s }: { s: string }) { return <span className={`rn-status s-${STATUS[s] ? s : "unknown"}`}>{STATUS[s] ?? s}</span>; }
function SourceBadge({ r }: { r: Pick<Run, "source" | "env"> }) {
  return r.source === "kaggle" ? <span className="rn-badge kaggle">Kaggle</span> : <span className="rn-badge manual">{typeof r.env?.platform === "string" ? r.env.platform : "Thủ công"}</span>;
}
function RunLabel({ r }: { r: Pick<Run, "ref" | "version"> }) { return r.ref ? <span className="rn-ref">{r.ref}{r.version ? ` · v${r.version}` : ""}</span> : null; }

function KvRows({ rows, setRows, keyHint, valueHint }: { rows: { k: string; v: string }[]; setRows: Dispatch<SetStateAction<{ k: string; v: string }[]>>; keyHint: string; valueHint: string }) {
  return <div className="rn-kv">
    {rows.map((row, i) => <div key={i} className="rn-kv-row"><input value={row.k} onChange={e => setRows(r => r.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} placeholder={keyHint} aria-label={`Tên ${i + 1}`} maxLength={100} /><input value={row.v} onChange={e => setRows(r => r.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} placeholder={valueHint} aria-label={`Giá trị ${i + 1}`} maxLength={1000} /><button type="button" className="icon-button" onClick={() => setRows(r => r.length > 1 ? r.filter((_, j) => j !== i) : [{ k: "", v: "" }])} aria-label="Xóa dòng"><X size={14} /></button></div>)}
    <button type="button" className="rn-link" onClick={() => setRows(r => [...r, { k: "", v: "" }])}><Plus size={12} /> Thêm dòng</button>
  </div>;
}

function CaptureModal({ accounts: all, data, onClose, onDone }: { accounts: Account[]; data: Record<number, SyncData>; onClose: () => void; onDone: (r: { run: Run; created: boolean }) => void }) {
  // Only a connection's creator may use its token, so only their own connections are offered.
  const accounts = all;
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? 0), [ref, setRef] = useState(""), [version, setVersion] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState(""), [err, setErr] = useState("");
  const notebooks = (data[accountId]?.notebooks ?? []).flatMap(n => { const r = typeof n.ref === "string" ? n.ref : ""; return REF.test(r) ? [{ ref: r, title: typeof n.title === "string" ? n.title : r }] : []; });
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(""); setNote("");
    if (!REF.test(ref.trim())) { setErr("Tên notebook phải có dạng owner/notebook."); return; }
    setBusy(true);
    try {
      const r = await call<{ skipped: true; reason: string } | { skipped: false; run: Run; created: boolean }>("/api/runs/capture", "POST", { account_id: accountId, ref: ref.trim(), ...(version.trim() ? { version: Number(version) } : {}) });
      if (r.skipped) setNote(r.reason); else onDone(r);
    } catch (x) { setErr(msg(x, "Không thể thu run.")); } finally { setBusy(false); }
  }
  return <div className="overlay" onClick={onClose}><div className="modal rn-modal" role="dialog" aria-modal="true" aria-labelledby="rn-cap-title" onClick={e => e.stopPropagation()}>
    <div className="modal-top"><div><div className="eyebrow">THEO DÕI THÍ NGHIỆM</div><h2 id="rn-cap-title">Thu run từ Kaggle</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={19} /></button></div>
    <p className="modal-description">Đọc ros_run.json hoặc dòng @@ROS trong log của phiên chạy đã xong. Thu lại cùng một version sẽ cập nhật run cũ, không tạo bản trùng.</p>
    {accounts.length === 0 ? <p className="rn-muted">Workspace này chưa có kết nối Kaggle nào. Hãy thêm kết nối ở mục Tài khoản Kaggle trước.</p> : <form onSubmit={submit}>
      <label>Tài khoản<select value={accountId} onChange={e => { setAccountId(Number(e.target.value)); setRef(""); }}>{accounts.map(a => <option key={a.id} value={a.id}>{a.label} (@{a.username})</option>)}</select></label>
      {notebooks.length ? <label>Notebook<select required value={ref} onChange={e => setRef(e.target.value)}><option value="">Chọn notebook…</option>{notebooks.map(n => <option key={n.ref} value={n.ref}>{n.title} · {n.ref}</option>)}</select></label>
        : <label>Notebook (owner/notebook)<input required value={ref} onChange={e => setRef(e.target.value)} placeholder="Ví dụ: researcher/vit-cifar10" /><small>Tài khoản này chưa có danh sách notebook. Đồng bộ ở mục Quota & tài nguyên để chọn từ danh sách.</small></label>}
      <label>Version (tùy chọn)<input value={version} onChange={e => setVersion(e.target.value)} inputMode="numeric" pattern="[0-9]*" placeholder="Bỏ trống để lấy phiên chạy mới nhất" /><small>Code chỉ được lưu kèm khi thu version hiện tại.</small></label>
      {note && <p className="rn-warn" role="status">Không thu run: {note}</p>}
      {err && <div className="alert error" role="alert">{err}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Hủy</button><button className="primary" disabled={busy || !ref.trim()}>{busy ? "Đang thu..." : "Thu run"}</button></div>
    </form>}
  </div></div>;
}

function ManualModal({ onClose, onDone }: { onClose: () => void; onDone: (r: Run) => void }) {
  const [name, setName] = useState(""), [platform, setPlatform] = useState(""), [status, setStatus] = useState("complete"), [runAt, setRunAt] = useState(""), [notes, setNotes] = useState(""), [tags, setTags] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const [config, setConfig] = useState([{ k: "", v: "" }]), [metrics, setMetrics] = useState([{ k: "", v: "" }]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr("");
    const cfg: Record<string, Scalar> = {}, met: Record<string, number> = {};
    for (const r of config) if (r.k.trim()) cfg[r.k.trim()] = parseScalar(r.v);
    for (const r of metrics) if (r.k.trim()) { const t = r.v.trim(), n = Number(t.includes(".") ? t : t.replace(",", ".")); if (!t || !Number.isFinite(n)) { setErr(`Metric “${r.k.trim()}” phải là số.`); return; } met[r.k.trim()] = n; }
    setBusy(true);
    try { onDone(await call<Run>("/api/runs", "POST", { name, platform: platform.trim() || undefined, status, config: cfg, metrics: met, notes, tags: tags.split(",").map(t => t.trim()).filter(Boolean), ...(runAt ? { run_at: new Date(runAt).toISOString() } : {}) })); }
    catch (x) { setErr(msg(x, "Không thể lưu run.")); } finally { setBusy(false); }
  }
  return <div className="overlay" onClick={onClose}><div className="modal rn-modal wide" role="dialog" aria-modal="true" aria-labelledby="rn-man-title" onClick={e => e.stopPropagation()}>
    <div className="modal-top"><div><div className="eyebrow">THEO DÕI THÍ NGHIỆM</div><h2 id="rn-man-title">Thêm run thủ công</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={19} /></button></div>
    <p className="modal-description">Ghi lại run chạy trên Colab, máy cá nhân hoặc nơi khác để so sánh cùng các run Kaggle.</p>
    <form onSubmit={submit}>
      <label>Tên run<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="Ví dụ: ViT-B/16 lr=3e-4 seed 42" /></label>
      <div className="rn-grid2">
        <label>Nền tảng<input maxLength={60} value={platform} onChange={e => setPlatform(e.target.value)} placeholder="Colab, GPU cá nhân…" list="rn-platforms" /></label>
        <label>Trạng thái<select value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <datalist id="rn-platforms"><option value="Colab" /><option value="GPU cá nhân" /><option value="Máy chủ phòng lab" /><option value="Kaggle (nhập tay)" /></datalist>
      <label>Thời điểm chạy (tùy chọn)<input type="datetime-local" value={runAt} onChange={e => setRunAt(e.target.value)} /></label>
      <div className="rn-field-label">Config <small>Số, true/false và null được tự nhận dạng.</small></div>
      <KvRows rows={config} setRows={setConfig} keyHint="lr" valueHint="0.0003" />
      <div className="rn-field-label">Metrics <small>Chỉ nhận giá trị số.</small></div>
      <KvRows rows={metrics} setRows={setMetrics} keyHint="val_acc" valueHint="0.912" />
      <label>Ghi chú<textarea rows={3} maxLength={20000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Thay đổi so với baseline, quan sát…" /></label>
      <label>Tag<input value={tags} onChange={e => setTags(e.target.value)} placeholder="Phân cách bằng dấu phẩy, ví dụ: baseline, vit" /></label>
      {err && <div className="alert error" role="alert">{err}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Hủy</button><button className="primary" disabled={busy}>{busy ? "Đang lưu..." : "Lưu run"}</button></div>
    </form>
  </div></div>;
}

function Drawer({ run, papers, alerts, close, patch, remove, loadCode }: { run: RunDetail; papers: PaperLite[] | null; alerts: ReactNode; close: () => void; patch: (body: object, done?: string) => Promise<boolean>; remove: () => void; loadCode: () => Promise<void> }) {
  const [nameEdit, setNameEdit] = useState<string | null>(null), [notes, setNotes] = useState(run.notes), [newTag, setNewTag] = useState(""), [copied, setCopied] = useState(false), [codeBusy, setCodeBusy] = useState(false);
  const hKeys = useMemo(() => historyKeys([run.history]), [run.history]);
  const [chartKey, setChartKey] = useState(() => hKeys[0] ?? "");
  const hasStep = (run.history ?? []).some(p => typeof p.step === "number");
  const metrics = Object.entries(run.metrics), config = Object.entries(run.config), env = Object.entries(run.env ?? {}).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  const paperOptions = papers ?? [];
  function addTag(e: FormEvent) { e.preventDefault(); const t = newTag.trim(); if (!t) return; if (run.tags.some(x => x.toLowerCase() === t.toLowerCase())) { setNewTag(""); return; } void patch({ tags: [...run.tags, t] }).then(ok => ok && setNewTag("")); }
  return <div className="rn-drawer-back" onClick={close}><aside className="rn-drawer" role="dialog" aria-modal="true" aria-labelledby="rn-drawer-title" onClick={e => e.stopPropagation()}>
    <div className="rn-drawer-head">
      {nameEdit !== null ? <form className="rn-name-form" onSubmit={e => { e.preventDefault(); void patch({ name: nameEdit }, "Đã đổi tên run.").then(ok => ok && setNameEdit(null)); }}><input autoFocus value={nameEdit} onChange={e => setNameEdit(e.target.value)} maxLength={200} required aria-label="Tên run" /><button className="primary">Lưu</button><button type="button" className="secondary" onClick={() => setNameEdit(null)}>Hủy</button></form>
        : <h2 id="rn-drawer-title"><span className="rn-id">#{run.id}</span> {run.name}<button className="rn-icon-sm" onClick={() => setNameEdit(run.name)} aria-label="Đổi tên run"><Pencil size={13} /></button></h2>}
      <button className="icon-button" onClick={close} aria-label="Đóng"><X size={18} /></button>
    </div>
    <div className="rn-meta"><SourceBadge r={run} /><StatusBadge s={run.status} /><RunLabel r={run} /><span>Chạy: {when(run.run_at ?? run.created_at)}</span>{run.created_by && <span className="rn-by">Tạo bởi <b>{run.created_by}</b></span>}{run.ref && run.source === "kaggle" && <a className="rn-link" href={`https://www.kaggle.com/code/${run.ref}`} target="_blank" rel="noreferrer">Mở Kaggle <ExternalLink size={11} /></a>}</div>
    <p className="rn-captured">Nguồn dữ liệu: <b>{CAPTURED[run.captured_from] ?? run.captured_from}</b>{run.source === "kaggle" && <> · thu lúc {when(run.captured_at)}</>}</p>
    {alerts}
    {run.failure_message && <div className="rn-failure"><b>Lỗi khi chạy</b><pre>{run.failure_message}</pre></div>}

    <div className="rn-section">Metrics cuối</div>
    {metrics.length ? <div className="rn-tiles">{metrics.map(([k, v]) => <div key={k} className="rn-tile"><span>{k}</span><b>{fmt(v)}</b><small>{lowerBetter(k) ? "thấp hơn là tốt" : "cao hơn là tốt"}</small></div>)}</div> : <p className="rn-muted">Run này chưa có metric.</p>}

    <div className="rn-section rn-section-row"><span>Lịch sử theo step</span>{hKeys.length > 1 && <select value={chartKey} onChange={e => setChartKey(e.target.value)} aria-label="Metric trên biểu đồ">{hKeys.map(k => <option key={k}>{k}</option>)}</select>}</div>
    <LineChart series={chartKey ? [{ name: chartKey, color: COLORS[0], points: pointsOf(run.history, chartKey) }] : []} metric={chartKey} xLabel={hasStep ? "Step" : "Lần ghi"} empty="Run này không có lịch sử metric. Gọi log_metric(step=..., ...) trong notebook để vẽ đường học." />

    <div className="rn-section rn-section-row"><span>Config ({config.length})</span>{config.length > 0 && <button className="rn-link" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(run.config, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => setCopied(false)); }}><Copy size={11} /> {copied ? "Đã sao chép" : "Sao chép JSON"}</button>}</div>
    {config.length ? <div className="rn-scroll rn-kvtable"><table><tbody>{config.map(([k, v]) => <tr key={k}><th>{k}</th><td>{show(v)}</td></tr>)}</tbody></table></div> : <p className="rn-muted">Run này chưa có config.</p>}

    {env.length > 0 && <><div className="rn-section">Môi trường</div><dl className="rn-env">{env.map(([k, v]) => <div key={k}><dt>{ENV_LABEL[k] ?? k}</dt><dd>{Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Bật" : "Tắt") : String(v)}</dd></div>)}</dl></>}

    <div className="rn-section">Tag</div>
    <div className="rn-tags">{run.tags.map(t => <span key={t} className="rn-tag">{t}<button onClick={() => void patch({ tags: run.tags.filter(x => x !== t) })} aria-label={`Gỡ tag ${t}`}><X size={11} /></button></span>)}
      <form className="rn-tag-add" onSubmit={addTag}><Tag size={13} /><input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="Thêm tag" aria-label="Thêm tag" maxLength={40} /></form></div>

    <div className="rn-section">Paper baseline</div>
    <select className="rn-select-full" value={run.paper_id ?? ""} onChange={e => void patch({ paper_id: e.target.value ? Number(e.target.value) : null }, e.target.value ? "Đã liên kết paper." : "Đã bỏ liên kết paper.")} aria-label="Paper baseline">
      <option value="">{papers === null ? "Đang tải thư viện…" : "Không liên kết paper"}</option>
      {run.paper_id && !paperOptions.some(p => p.id === run.paper_id) && <option value={run.paper_id}>Paper #{run.paper_id}</option>}
      {paperOptions.map(p => <option key={p.id} value={p.id}>{p.title.length > 90 ? `${p.title.slice(0, 89)}…` : p.title}{p.year ? ` (${p.year})` : ""}</option>)}
    </select>

    <div className="rn-section">Ghi chú</div>
    <textarea className="rn-notes" rows={4} maxLength={20000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Nhận xét, giả thuyết, việc cần thử tiếp…" aria-label="Ghi chú" />
    {notes !== run.notes && <div className="rn-actions"><button className="primary" onClick={() => void patch({ notes }, "Đã lưu ghi chú.")}>Lưu ghi chú</button><button className="secondary" onClick={() => setNotes(run.notes)}>Hoàn tác</button></div>}

    <div className="rn-section rn-section-row"><span>Code notebook</span>{run.code_hash && <small className="rn-muted" title={run.code_hash}>sha256 {run.code_hash.slice(0, 12)}</small>}</div>
    {run.code === undefined ? <button className="secondary" disabled={codeBusy} onClick={() => { setCodeBusy(true); void loadCode().finally(() => setCodeBusy(false)); }}><Code2 size={14} /> {codeBusy ? "Đang tải..." : "Xem code"}</button>
      : run.code ? <pre className="rn-code">{run.code}</pre> : <p className="rn-muted">Không có bản chụp code cho run này.</p>}

    {run.can_delete !== false ? <div className="rn-danger"><button className="secondary danger" onClick={remove}><Trash2 size={14} /> Xóa run</button></div>
      : <div className="rn-danger"><p className="rn-muted">Chỉ người tạo run hoặc quản trị workspace mới xóa được run này.</p></div>}
  </aside></div>;
}

function CompareView({ data, history, back, open }: { data: Compare; history: Record<number, Point[]>; back: () => void; open: (id: number) => void }) {
  const [sameOpen, setSameOpen] = useState(false);
  const keys = useMemo(() => historyKeys(data.runs.map(r => history[r.id])), [data, history]);
  const [metric, setMetric] = useState(() => data.metrics.find(m => keys.includes(m.key))?.key ?? keys[0] ?? "");
  const drawn = data.runs.slice(0, COLORS.length), cols = data.runs.length + 1;
  const series = drawn.map((r, i) => ({ name: `#${r.id} ${r.name}`, color: COLORS[i], points: pointsOf(history[r.id], metric) }));
  const missing = series.filter(s => !s.points.length).map(s => s.name.split(" ")[0]);
  const hasStep = drawn.some(r => (history[r.id] ?? []).some(p => typeof p.step === "number"));
  const envOf = (r: CompareRun) => [r.env?.accelerator, r.env?.platform].filter(v => typeof v === "string").join(" · ") || "—";
  return <section className="panel">
    <div className="panel-heading"><div><h2><GitCompareArrows size={17} /> So sánh {data.runs.length} run</h2><p>Dòng tô vàng là config khác nhau giữa các run. <Trophy size={11} /> đánh dấu giá trị tốt nhất của từng metric.</p></div><button className="secondary" onClick={back}>Quay lại danh sách</button></div>
    <div className="rn-body">
      <div className="rn-scroll"><table className="rn-cmp">
        <thead><tr><th className="rn-cmp-key">Run</th>{data.runs.map((r, i) => <th key={r.id}><button className="rn-cmp-run" onClick={() => open(r.id)}>{i < COLORS.length && <i style={{ background: COLORS[i] }} />}<b>#{r.id} {r.name}</b></button><div className="rn-meta tight"><SourceBadge r={r} /><StatusBadge s={r.status} /></div><RunLabel r={r} /></th>)}</tr></thead>
        <tbody>
          <tr><th className="rn-cmp-key">Thời điểm chạy</th>{data.runs.map(r => <td key={r.id}>{when(r.run_at)}</td>)}</tr>
          <tr><th className="rn-cmp-key">Môi trường</th>{data.runs.map(r => <td key={r.id}>{envOf(r)}</td>)}</tr>
          <tr className="rn-cmp-group"><th colSpan={cols}>Metrics ({data.metrics.length})</th></tr>
          {data.metrics.map(m => <tr key={`m${m.key}`}><th className="rn-cmp-key">{m.key}<small>{m.better === "lower" ? "↓ thấp hơn là tốt" : "↑ cao hơn là tốt"}</small></th>{m.values.map((v, i) => <td key={i} className={m.best_index === i ? "rn-best" : ""}>{m.best_index === i && <Trophy size={11} aria-label="Tốt nhất" />} {fmt(v)}</td>)}</tr>)}
          {!data.metrics.length && <tr><td colSpan={cols} className="rn-muted">Các run này chưa có metric.</td></tr>}
          <tr className="rn-cmp-group"><th colSpan={cols}>Config khác nhau ({data.config_diff.length})</th></tr>
          {data.config_diff.map(c => <tr key={`d${c.key}`} className="rn-diff"><th className="rn-cmp-key">{c.key}</th>{c.values.map((v, i) => <td key={i}>{show(v)}</td>)}</tr>)}
          {!data.config_diff.length && <tr><td colSpan={cols} className="rn-muted">Config của các run giống hệt nhau.</td></tr>}
          <tr className="rn-cmp-group"><th colSpan={cols}><button className="rn-link" onClick={() => setSameOpen(o => !o)} aria-expanded={sameOpen}>{sameOpen ? "Ẩn" : "Hiện"} config giống nhau ({data.config_same.length})</button></th></tr>
          {sameOpen && data.config_same.map(c => <tr key={`s${c.key}`}><th className="rn-cmp-key">{c.key}</th><td colSpan={cols - 1}>{show(c.value)}</td></tr>)}
        </tbody>
      </table></div>
      <div className="rn-section rn-section-row"><span>Đường học chồng lớp</span>{keys.length > 0 && <select value={metric} onChange={e => setMetric(e.target.value)} aria-label="Metric để so sánh">{keys.map(k => <option key={k}>{k}</option>)}</select>}</div>
      <LineChart series={series} metric={metric} xLabel={hasStep ? "Step" : "Lần ghi"} empty="Các run đã chọn không có lịch sử metric để vẽ." />
      {data.runs.length > COLORS.length && <p className="rn-muted">Biểu đồ chỉ vẽ {COLORS.length} run đầu để các màu còn phân biệt được.</p>}
      {metric && missing.length > 0 && missing.length < series.length && <p className="rn-muted">Không có lịch sử “{metric}”: {missing.join(", ")}.</p>}
    </div>
  </section>;
}

export default function RunsScreen({ accounts, data }: { accounts: Account[]; data: Record<number, SyncData> }) {
  const [items, setItems] = useState<Run[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true);
  const [q, setQ] = useState(""), [source, setSource] = useState(""), [status, setStatus] = useState(""), [tag, setTag] = useState("");
  const [sort, setSort] = useState("newest"), [metric, setMetric] = useState(""), [order, setOrder] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<number[]>([]);
  const [metricPick, setMetricPick] = useState<string[] | null>(null), [configPick, setConfigPick] = useState<string[] | null>(null), [colsOpen, setColsOpen] = useState(false);
  const [knownTags, setKnownTags] = useState<string[]>([]), [knownMetrics, setKnownMetrics] = useState<string[]>([]);
  const [open, setOpen] = useState<RunDetail | null>(null), [papers, setPapers] = useState<PaperLite[] | null>(null);
  const [compare, setCompare] = useState<{ data: Compare; history: Record<number, Point[]> } | null>(null), [comparing, setComparing] = useState(false);
  const [modal, setModal] = useState<"capture" | "manual" | null>(null);
  const [error, setError] = useState(""), [info, setInfo] = useState(""), [workspace, setWorkspace] = useState("");
  const reqId = useRef(0);
  useEffect(() => { call<{ name?: string }>("/api/workspace").then(w => setWorkspace(typeof w?.name === "string" ? w.name : "")).catch(() => {}); }, []);

  const qs = useCallback(() => new URLSearchParams({ q, source, status, tag, sort, ...(sort === "metric" && metric ? { metric, order } : {}) }).toString(), [q, source, status, tag, sort, metric, order]);
  const reload = useCallback(async () => {
    const id = ++reqId.current; setLoading(true);
    try { const r = await call<Page>(`/api/runs?limit=${PAGE}&offset=0&${qs()}`); if (id !== reqId.current) return; setItems(r.items); setTotal(r.total); }
    catch (e) { if (id === reqId.current) setError(msg(e, "Không thể tải danh sách run.")); } finally { if (id === reqId.current) setLoading(false); }
  }, [qs]);
  useEffect(() => { const t = setTimeout(() => void reload(), q ? 300 : 0); return () => clearTimeout(t); }, [reload, q]);
  // Tag and metric pickers remember every value seen, so filtering does not shrink the choices.
  useEffect(() => { setKnownTags(old => [...new Set([...old, ...items.flatMap(r => r.tags)])].sort()); setKnownMetrics(old => [...new Set([...old, ...items.flatMap(r => Object.keys(r.metrics))])].sort()); }, [items]);
  useEffect(() => { if (open && papers === null) call<{ items: PaperLite[] }>("/api/papers?limit=100").then(r => setPapers(r.items)).catch(() => setPapers([])); }, [open, papers]);
  useEffect(() => {
    if (!open && !modal) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { if (modal) setModal(null); else setOpen(null); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [open, modal]);

  async function loadMore() {
    setLoading(true);
    try { const r = await call<Page>(`/api/runs?limit=${PAGE}&offset=${items.length}&${qs()}`); setItems(old => [...old, ...r.items.filter(n => !old.some(o => o.id === n.id))]); setTotal(r.total); } catch (e) { setError(msg(e, "Không thể tải thêm.")); } finally { setLoading(false); }
  }
  async function view(id: number) { setError(""); setInfo(""); try { setOpen(await call<RunDetail>(`/api/runs/${id}`)); } catch (e) { setError(msg(e, "Không thể tải run.")); } }
  async function patch(body: object, done?: string) {
    if (!open) return false; setError(""); setInfo("");
    try {
      const r = await call<RunDetail>(`/api/runs/${open.id}`, "PATCH", body);
      setOpen(o => o && { ...o, ...r, code: o.code, history: r.history ?? o.history });
      setItems(list => list.map(x => x.id === r.id ? { ...x, name: r.name, notes: r.notes, tags: r.tags, paper_id: r.paper_id, status: r.status, config: r.config, metrics: r.metrics } : x));
      if (done) setInfo(done); return true;
    } catch (e) { setError(msg(e, "Không thể cập nhật run.")); return false; }
  }
  async function remove() {
    if (!open || !window.confirm(`Xóa run “${open.name}”? Config, metrics, lịch sử và code đã lưu sẽ mất, không thể hoàn tác.`)) return;
    try { await call(`/api/runs/${open.id}`, "DELETE"); const id = open.id; setOpen(null); setSelected(s => s.filter(x => x !== id)); setInfo("Đã xóa run."); await reload(); } catch (e) { setError(msg(e, "Không thể xóa run.")); }
  }
  async function loadCode() {
    if (!open) return; const id = open.id;
    try { const r = await call<RunDetail>(`/api/runs/${id}?code=1`); setOpen(o => o && o.id === id ? { ...o, code: r.code ?? null } : o); } catch (e) { setError(msg(e, "Không thể tải code.")); }
  }
  async function runCompare() {
    const ids = selected.slice(0, MAX_COMPARE); setComparing(true); setError(""); setInfo("");
    try {
      const [d, details] = await Promise.all([call<Compare>(`/api/runs/compare?ids=${ids.join(",")}`), Promise.all(ids.map(id => call<RunDetail>(`/api/runs/${id}`)))]);
      setCompare({ data: d, history: Object.fromEntries(details.map(r => [r.id, r.history ?? []])) });
      setTimeout(() => document.getElementById("rn-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) { setError(msg(e, "Không thể so sánh các run.")); } finally { setComparing(false); }
  }
  function toggle(id: number) {
    setSelected(s => { if (s.includes(id)) return s.filter(x => x !== id); if (s.length >= MAX_COMPARE) { setInfo(`Chỉ so sánh được tối đa ${MAX_COMPARE} run.`); return s; } return [...s, id]; });
  }
  function pickMetricSort(k: string) {
    if (sort === "metric" && metric === k) setOrder(o => o === "asc" ? "desc" : "asc");
    else { setSort("metric"); setMetric(k); setOrder(lowerBetter(k) ? "asc" : "desc"); }
  }

  // Columns: union of keys across loaded runs; config defaults to keys whose values differ.
  const metricKeys = useMemo(() => keysByFrequency(items.map(r => r.metrics)), [items]);
  const configKeys = useMemo(() => keysByFrequency(items.map(r => r.config)), [items]);
  const autoConfig = useMemo(() => { const varies = configKeys.filter(k => new Set(items.map(r => JSON.stringify(r.config[k] ?? null))).size > 1); return [...varies, ...configKeys.filter(k => !varies.includes(k))].slice(0, MAX_CONFIG_COLS); }, [items, configKeys]);
  const mCols = (metricPick ?? metricKeys).filter(k => metricKeys.includes(k)).slice(0, MAX_METRIC_COLS), cCols = (configPick ?? autoConfig).filter(k => configKeys.includes(k)).slice(0, MAX_CONFIG_COLS);
  const best: Record<string, number | null> = Object.fromEntries(mCols.map(k => { const v = items.map(r => r.metrics[k]).filter((x): x is number => typeof x === "number"); return [k, v.length < 2 ? null : lowerBetter(k) ? Math.min(...v) : Math.max(...v)]; }));
  function pick(cur: string[], set: (v: string[]) => void, k: string, max: number) { set(cur.includes(k) ? cur.filter(x => x !== k) : cur.length < max ? [...cur, k] : cur); }

  const filtered = !!q || !!source || !!status || !!tag;
  const allShown = items.filter(r => !selected.includes(r.id)).length === 0 && items.length > 0;
  const metricOptions = [...new Set([...knownMetrics, ...(metric ? [metric] : [])])].sort();
  const alerts = <>{error && <div className="alert error" role="alert">{error}<button className="rn-alert-x" onClick={() => setError("")} aria-label="Đóng thông báo"><X size={14} /></button></div>}{info && <div className="alert rn-info" role="status">{info}<button className="rn-alert-x" onClick={() => setInfo("")} aria-label="Đóng thông báo"><X size={14} /></button></div>}</>;

  return <div className="rn">
    <div className="heading screen-heading"><div><div className="eyebrow"><span /> THEO DÕI THÍ NGHIỆM</div><h1>Thí nghiệm</h1><p>{workspace && <>Run dùng chung trong workspace <b>{workspace}</b>. </>}Lưu config, metrics và đường học của từng lần chạy, rồi so sánh các run cạnh nhau để chọn hướng đi tiếp.</p></div>
      <div className="rn-head-actions"><button className="secondary" onClick={() => { setError(""); setModal("manual"); }}><Plus size={15} /> Thêm run thủ công</button><button className="primary" onClick={() => { setError(""); setModal("capture"); }}><CloudDownload size={16} /> Thu run từ Kaggle</button></div></div>
    {!open && alerts}

    <section className="panel rn-toolbar-panel">
      <label className="rn-search"><Search size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm theo tên run, notebook hoặc ghi chú" aria-label="Tìm run" /></label>
      <div className="rn-toolbar">
        <label>Nguồn<select value={source} onChange={e => setSource(e.target.value)}><option value="">Tất cả</option><option value="kaggle">Kaggle</option><option value="manual">Thủ công</option></select></label>
        <label>Trạng thái<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Tất cả</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Tag<select value={tag} onChange={e => setTag(e.target.value)}><option value="">Tất cả</option>{[...new Set([...knownTags, ...(tag ? [tag] : [])])].map(t => <option key={t}>{t}</option>)}</select></label>
        <label>Sắp xếp<select value={sort} onChange={e => { const v = e.target.value; setSort(v); if (v === "metric" && !metric && metricOptions[0]) { setMetric(metricOptions[0]); setOrder(lowerBetter(metricOptions[0]) ? "asc" : "desc"); } }}><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option><option value="metric" disabled={!metricOptions.length}>Theo metric</option></select></label>
        {sort === "metric" && <>
          <label>Metric<select value={metric} onChange={e => { setMetric(e.target.value); setOrder(lowerBetter(e.target.value) ? "asc" : "desc"); }}>{metricOptions.map(k => <option key={k}>{k}</option>)}</select></label>
          <label>Thứ tự<select value={order} onChange={e => setOrder(e.target.value as "asc" | "desc")}><option value="asc">Tăng dần{metric && lowerBetter(metric) ? " (tốt nhất trước)" : ""}</option><option value="desc">Giảm dần{metric && !lowerBetter(metric) ? " (tốt nhất trước)" : ""}</option></select></label>
        </>}
      </div>
    </section>

    <div id="rn-results" className="rn-anchor" />
    {compare ? <CompareView key={compare.data.runs.map(r => r.id).join(",")} data={compare.data} history={compare.history} back={() => setCompare(null)} open={id => void view(id)} /> : <section className="panel">
      <div className="panel-heading"><div><h2>Các run <span className="count">{total}</span></h2><p>{filtered ? `${total} run khớp bộ lọc.` : "Bấm vào tên run để xem chi tiết. Chọn từ 2 run để so sánh."}</p></div><button className={`secondary rn-cols-btn ${colsOpen ? "on" : ""}`} onClick={() => setColsOpen(o => !o)} aria-expanded={colsOpen} disabled={!metricKeys.length && !configKeys.length}><Columns3 size={14} /> Chọn cột</button></div>
      <div className="rn-body">
        {colsOpen && <div className="rn-cols">
          <div><b>Metric <small>({mCols.length}/{MAX_METRIC_COLS})</small></b><div className="rn-chips">{metricKeys.map(k => <label key={k} className={mCols.includes(k) ? "on" : ""}><input type="checkbox" checked={mCols.includes(k)} disabled={!mCols.includes(k) && mCols.length >= MAX_METRIC_COLS} onChange={() => pick(mCols, setMetricPick, k, MAX_METRIC_COLS)} />{k}</label>)}{!metricKeys.length && <span className="rn-muted">Chưa có metric.</span>}</div></div>
          <div><b>Config <small>({cCols.length}/{MAX_CONFIG_COLS})</small></b><div className="rn-chips">{configKeys.map(k => <label key={k} className={cCols.includes(k) ? "on" : ""}><input type="checkbox" checked={cCols.includes(k)} disabled={!cCols.includes(k) && cCols.length >= MAX_CONFIG_COLS} onChange={() => pick(cCols, setConfigPick, k, MAX_CONFIG_COLS)} />{k}</label>)}{!configKeys.length && <span className="rn-muted">Chưa có config.</span>}</div></div>
          <button className="rn-link" onClick={() => { setMetricPick(null); setConfigPick(null); }}>Tự động chọn lại</button>
        </div>}
        {selected.length > 0 && <div className="rn-bulk" role="region" aria-label="Run đã chọn"><b>Đã chọn {selected.length}/{MAX_COMPARE}</b><button className="primary" disabled={selected.length < 2 || comparing} onClick={() => void runCompare()}><GitCompareArrows size={14} /> {comparing ? "Đang tải..." : "So sánh"}</button>{selected.length < 2 && <span className="rn-muted">Chọn thêm ít nhất 1 run.</span>}<button className="icon-button" onClick={() => setSelected([])} aria-label="Bỏ chọn"><X size={14} /></button></div>}
        {items.length > 0 && <div className="rn-scroll rn-tablewrap"><table className="rn-table">
          <thead><tr>
            <th className="rn-check"><input type="checkbox" checked={allShown} onChange={() => setSelected(s => allShown ? s.filter(id => !items.some(r => r.id === id)) : [...s, ...items.map(r => r.id).filter(id => !s.includes(id))].slice(0, MAX_COMPARE))} aria-label="Chọn các run đang hiển thị (tối đa 10)" /></th>
            <th>Run</th><th>Trạng thái</th><th>Thời điểm chạy</th>
            {mCols.map(k => <th key={`m${k}`} className="rn-num"><button className={`rn-sort ${sort === "metric" && metric === k ? "on" : ""}`} onClick={() => pickMetricSort(k)} title={`Sắp xếp theo ${k} (${lowerBetter(k) ? "thấp hơn là tốt" : "cao hơn là tốt"})`}>{k}<ArrowUpDown size={11} /></button></th>)}
            {cCols.map(k => <th key={`c${k}`} className="rn-cfg">{k}</th>)}
          </tr></thead>
          <tbody>{items.map(r => <tr key={r.id} className={`${open?.id === r.id ? "selected" : ""} ${selected.includes(r.id) ? "checked" : ""}`}>
            <td className="rn-check"><input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Chọn ${r.name}`} /></td>
            <td className="rn-name"><button onClick={() => void view(r.id)}><b>{r.name}</b></button><div className="rn-meta tight"><SourceBadge r={r} /><RunLabel r={r} />{r.created_by && <span className="rn-by">Tạo bởi {r.created_by}</span>}{r.tags.slice(0, 2).map(t => <span key={t} className="rn-tag small">{t}</span>)}{r.tags.length > 2 && <span className="rn-tag small">+{r.tags.length - 2}</span>}</div></td>
            <td><StatusBadge s={r.status} /></td>
            <td className="rn-time">{when(r.run_at ?? r.created_at)}</td>
            {mCols.map(k => { const v = r.metrics[k], isBest = typeof v === "number" && best[k] === v; return <td key={`m${k}`} className={`rn-num ${isBest ? "rn-best" : ""}`}>{isBest && <Trophy size={11} aria-label="Tốt nhất" />}{fmt(v)}</td>; })}
            {cCols.map(k => <td key={`c${k}`} className="rn-cfg" title={show(r.config[k])}>{k in r.config ? show(r.config[k]) : "—"}</td>)}
          </tr>)}</tbody>
        </table></div>}
        {loading && items.length === 0 && <div className="rn-empty">Đang tải...</div>}
        {!loading && total === 0 && (filtered ? <div className="rn-empty"><h3>Không có run khớp bộ lọc</h3><p>Thử bỏ bớt bộ lọc hoặc đổi từ khóa.</p></div> : <div className="rn-empty">
          <div className="rn-empty-icon"><TestTubes size={22} /></div><h3>Chưa có run nào</h3>
          <p>Thêm hai dòng vào notebook Kaggle để ghi config và metrics. Khi notebook chạy xong, bấm “Thu run từ Kaggle” hoặc mở notebook ở mục Logs & hoạt động, run sẽ được lưu vào đây.</p>
          <pre className="rn-snippet">{SNIPPET}</pre>
          <p className="rn-muted">Hướng dẫn đầy đủ (cài ros_tracker, định dạng ros_run.json, dòng @@ROS trong log): <code>docs/EXPERIMENT_TRACKING.md</code>.</p>
          <div className="rn-actions center"><button className="primary" onClick={() => setModal("capture")}><CloudDownload size={15} /> Thu run từ Kaggle</button><button className="secondary" onClick={() => setModal("manual")}><Plus size={15} /> Thêm run thủ công</button></div>
        </div>)}
        {items.length < total && <button className="secondary rn-more" disabled={loading} onClick={() => void loadMore()}>{loading ? "Đang tải..." : `Tải thêm (${total - items.length} còn lại)`}</button>}
      </div>
    </section>}

    {open && <Drawer key={open.id} run={open} papers={papers} alerts={alerts} close={() => setOpen(null)} patch={patch} remove={() => void remove()} loadCode={loadCode} />}
    {modal === "capture" && <CaptureModal accounts={accounts} data={data} onClose={() => setModal(null)} onDone={r => { setModal(null); void reload(); void view(r.run.id); setInfo(r.created ? `Đã thu run #${r.run.id}: ${r.run.name}.` : `Đã cập nhật run #${r.run.id}: ${r.run.name}.`); }} />}
    {modal === "manual" && <ManualModal onClose={() => setModal(null)} onDone={r => { setModal(null); void reload(); void view(r.id); setInfo(`Đã thêm run #${r.id}: ${r.name}.`); }} />}
  </div>;
}

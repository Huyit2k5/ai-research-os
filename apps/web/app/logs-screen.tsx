"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, RefreshCw, Search, TerminalSquare } from "lucide-react";
import type { Account, SyncData } from "./connector-screens";

// version: a past notebook version to read (undefined = latest session); latest: currentVersionNumber from the synced list, when Kaggle sends it.
type Selection = { account: Account; ref: string; title: string; latest?: number; version?: number };
type LogResult = { ref: string; content: string; truncated: boolean; fetched_at: string };
type RunStatus = { status: string; failure_message: string; fetched_at: string; run?: { id: number; created: boolean; captured_from: string } | null; capture_error?: string };
const STATUS_LABEL: Record<string, string> = { queued: "Đang chờ", running: "Đang chạy", complete: "Hoàn tất", error: "Lỗi", cancel_requested: "Đang hủy", cancel_acknowledged: "Đã hủy", unknown: "Không rõ" };
const ACTIVE = new Set(["queued", "running", "cancel_requested"]);
const API = "";

function formatLog(content: string) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "object" && item !== null && "data" in item)) {
      return parsed.map(item => `${item.time ? `[${String(item.time)}] ` : ""}${String(item.data ?? "")}`).join("\n");
    }
  } catch { /* Plain text and truncated JSON remain readable as returned. */ }
  return content;
}

export default function LogsScreen({ accounts, data, navigate }: { accounts: Account[]; data: Record<number, SyncData>; navigate: () => void }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<LogResult | null>(null);
  const [query, setQuery] = useState(""); const [accountFilter, setAccountFilter] = useState(""); const [notebookFilter, setNotebookFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [liveStatus, setLiveStatus] = useState("");
  const [liveTrimmed, setLiveTrimmed] = useState(false);
  const liveController = useRef<AbortController | null>(null);
  const liveSize = useRef(0);
  const requestId = useRef(0);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  useEffect(() => {
    if (!selection || selection.version) return; // status and live logs exist only for the latest session
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    setRunStatus(null); setStatusError("");
    async function poll() {
      let active = true;
      try {
        const response = await fetch(`${API}/api/accounts/${selection!.account.id}/notebook-status?ref=${encodeURIComponent(selection!.ref)}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) { setStatusError(typeof body.detail === "string" ? body.detail : "Không thể lấy trạng thái chạy."); active = false; }
        else { setRunStatus(body as RunStatus); setStatusError(""); active = ACTIVE.has((body as RunStatus).status); }
      } catch { if (!cancelled) { setStatusError("Không thể lấy trạng thái chạy."); active = false; } }
      if (!cancelled && active) timer = setTimeout(() => void poll(), 10000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selection]);
  useEffect(() => () => { liveController.current?.abort(); requestId.current++; }, []);
  const notebooks = accounts.flatMap(account => (data[account.id]?.notebooks ?? []).flatMap(item => {
    const ref = typeof item.ref === "string" ? item.ref : "";
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref)) return [];
    const latest = Number(item.currentVersionNumber);
    return [{ account, ref, title: typeof item.title === "string" ? item.title : ref, latest: Number.isInteger(latest) && latest > 0 ? latest : undefined }];
  }));
  const key = (item: Selection) => `${item.account.id}:${item.ref}`;
  const inAccount = notebooks.filter(item => !accountFilter || String(item.account.id) === accountFilter);
  const filtered = inAccount.filter(item => (!notebookFilter || key(item) === notebookFilter) &&`${item.title} ${item.ref} ${item.account.label} ${item.account.username}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  // Accounts that have notebooks; labels are not unique, so the username is appended when two accounts share a label.
  const withNotebooks = accounts.filter(account => notebooks.some(item => item.account.id === account.id));
  const accountName = (account: Account) => withNotebooks.filter(other => other.label === account.label).length > 1 ? `${account.label} (@${account.username})` : account.label;
  const multi = withNotebooks.length > 1;
  const groups = withNotebooks.map(account => ({ account, items: filtered.filter(item => item.account.id === account.id) })).filter(group => group.items.length);

  async function load(item: Selection) {
    const id = ++requestId.current;
    liveController.current?.abort(); liveController.current = null; setLive(false); setLiveText(""); setLiveStatus(""); setLiveTrimmed(false);
    setSelection(item); setResult(null); setError(""); setLoading(true);
    try {
      const response = await fetch(`${API}/api/accounts/${item.account.id}/notebook-logs?ref=${encodeURIComponent(item.version ? `${item.ref}/${item.version}` : item.ref)}`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.detail === "string" ? body.detail : "Không thể tải logs.");
      }
      const body: LogResult = await response.json();
      if (id === requestId.current) setResult(body);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : "Không thể tải logs.");
    } finally { if (id === requestId.current) setLoading(false); }
  }

  async function follow() {
    if (!selection || liveController.current) return;
    const controller = new AbortController(); liveController.current = controller;
    setLive(true); setLiveText(""); setLiveTrimmed(false); liveSize.current = 0; setError(""); setLiveStatus("Đang kết nối Kaggle...");
    try {
      const response = await fetch(`${API}/api/accounts/${selection.account.id}/notebook-logs-stream?ref=${encodeURIComponent(selection.ref)}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === "string" ? body.detail : "Không thể mở luồng logs. Hãy thử lại."); }
      if (!response.body) throw new Error("Không thể mở luồng logs. Hãy thử lại.");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          const event = pending.slice(0, end); pending = pending.slice(end + 2);
          const kind = event.match(/^event: (.+)$/m)?.[1], raw = event.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const payload = JSON.parse(raw) as { text?: string; message?: string };
          if (kind === "log" && payload.text) { const text = payload.text; liveSize.current += text.length; if (liveSize.current > 256 * 1024) setLiveTrimmed(true); setLiveStatus("Đang theo dõi trực tiếp"); setLiveText(old => (old + text).slice(-256 * 1024)); }
          if (kind === "status" || kind === "done") setLiveStatus(payload.message || "");
          if (kind === "error") { setError(payload.message || "Không thể theo dõi logs."); setLiveStatus(""); }
        }
      }
    } catch (err) { if (!controller.signal.aborted) { setLiveStatus(""); setError(err instanceof Error ? err.message : "Không thể theo dõi logs."); } }
    finally { if (liveController.current === controller) { liveController.current = null; setLive(false); } }
  }
  function stop() { liveController.current?.abort(); liveController.current = null; setLive(false); setLiveStatus("Đã dừng theo dõi."); }

  return <>
    <div className="heading screen-heading"><div><div className="eyebrow"><span /> THEO DÕI</div><h1>Logs & hoạt động</h1><p>Chọn notebook để xem logs của phiên gần nhất trên Kaggle.</p></div></div>
    <div className="info-banner"><TerminalSquare size={18} /><div><b>Logs và theo dõi trực tiếp</b><p>Chọn notebook để xem bản chụp hoặc theo dõi logs trực tiếp khi Kaggle cung cấp.</p></div></div>
    <div className="logs-grid"><section className="panel logs-list-panel"><div className="panel-heading"><div><h2>Notebook</h2><p>{multi ? `${notebooks.length} notebook từ ${withNotebooks.length} tài khoản đã đồng bộ.` : "Danh sách từ các tài khoản đã đồng bộ."}</p></div></div>
      {multi && <label className="log-filter"><span>Tài khoản</span><select value={accountFilter} onChange={event => { setAccountFilter(event.target.value); setNotebookFilter(""); }} aria-label="Lọc theo tài khoản"><option value="">Tất cả tài khoản ({withNotebooks.length})</option>{withNotebooks.map(account => <option key={account.id} value={account.id}>{accountName(account)}</option>)}</select></label>}
      {inAccount.length > 1 && <label className="log-filter"><span>Notebook</span><select value={notebookFilter} onChange={event => { setNotebookFilter(event.target.value); const item = inAccount.find(n => key(n) === event.target.value); if (item) void load(item); }} aria-label="Lọc theo notebook"><option value="">Tất cả notebook ({inAccount.length})</option>{inAccount.map(item => <option key={key(item)} value={key(item)}>{item.title}{multi && !accountFilter ? ` · ${accountName(item.account)}` : ""}</option>)}</select></label>}
      {notebooks.length > 0 && <label className="log-search"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm notebook" aria-label="Tìm notebook" /></label>}
      <div className="logs-list">{groups.map(group => <div className="log-group" key={group.account.id}>{multi && <div className="log-group-head"><span>{accountName(group.account)}</span><small>{group.items.length}</small></div>}{group.items.map(item => <button key={`${item.account.id}:${item.ref}`} className={`log-notebook ${selection?.account.id === item.account.id && selection.ref === item.ref ? "selected" : ""}`} onClick={() => void load(item)}><BookOpen size={18}/><span><b>{item.title}</b><small>{multi ? item.ref : `${item.account.label} · ${item.ref}`}</small></span></button>)}</div>)}
      {notebooks.length === 0 && <div className="empty screen-empty"><div className="empty-icon"><BookOpen size={23}/></div><h3>Chưa có notebook</h3><p>Đồng bộ tài khoản để tải danh sách notebook vào phiên làm việc.</p><button className="secondary" onClick={navigate}>Đến trang đồng bộ</button></div>}
      {notebooks.length > 0 && filtered.length === 0 && <div className="empty">Không tìm thấy notebook phù hợp.</div>}</div></section>
      <section className="panel log-viewer"><div className="panel-heading"><div><h2>{selection?.title ?? "Trình xem logs"}</h2><p>{selection ? `${accountName(selection.account)} · ${selection.ref}` : "Chọn một notebook từ danh sách."}</p></div>{selection && <div className="log-version"><label><span>Version</span>{selection.latest ? <select value={selection.version ?? ""} disabled={loading} onChange={event => void load({ ...selection, version: Number(event.target.value) || undefined })} aria-label="Chọn version"><option value="">Mới nhất (v{selection.latest})</option>{Array.from({ length: selection.latest }, (_, i) => selection.latest! - i).map(v => <option key={v} value={v}>v{v}</option>)}</select> : <input type="number" min={1} placeholder="Mới nhất" defaultValue={selection.version ?? ""} key={key(selection)} disabled={loading} onKeyDown={event => { if (event.key === "Enter") void load({ ...selection, version: Number(event.currentTarget.value) || undefined }); }} aria-label="Nhập version rồi nhấn Enter" title="Nhập số version rồi nhấn Enter; để trống là bản mới nhất" />}</label><button className="secondary" disabled={loading} onClick={() => void load(selection)}><RefreshCw size={15}/> Làm mới</button></div>}</div>
      {selection?.version && <div className="log-meta">Đang xem logs của version v{selection.version}. Trạng thái chạy và theo dõi trực tiếp chỉ có ở bản mới nhất.</div>}
      {selection && !selection.version && <div className="log-meta" aria-live="polite"><b>Trạng thái chạy: </b>{statusError ? statusError : runStatus ? `${STATUS_LABEL[runStatus.status] ?? runStatus.status}${runStatus.failure_message ? ` — ${runStatus.failure_message}` : ""}${ACTIVE.has(runStatus.status) ? " (tự cập nhật mỗi 10 giây)" : ""}` : "Đang tải..."}</div>}
      {!selection?.version && runStatus?.run && <div className="log-meta rn-log-saved" role="status">Đã lưu kết quả run #{runStatus.run.id} vào Thí nghiệm</div>}
      {!selection?.version && runStatus?.capture_error && <div className="log-meta rn-log-warn">{runStatus.capture_error}</div>}
      {selection && !selection.version && <div className="log-controls"><button className="secondary" disabled={loading} onClick={live ? stop : () => void follow()}>{live ? "Dừng theo dõi" : "Theo dõi trực tiếp"}</button><span>{liveStatus}</span></div>}
      {selection && <div className="log-meta">{liveStatus ? (liveTrimmed ? "Chỉ giữ phần logs mới nhất trong trình duyệt." : "") : loading ? "Đang tải logs..." : result ? `Đã tải lúc ${new Date(result.fetched_at).toLocaleString("vi-VN")}` : ""}{!liveStatus && result?.truncated && " · Chỉ hiển thị 256 KB cuối"}</div>}
      {error && <div className="alert error log-alert" role="alert">{error}</div>}
      {(result || liveStatus) && <pre className="log-content">{liveStatus ? (liveText || "Đang chờ logs từ Kaggle...") : result?.content ? formatLog(result.content) : "Kaggle chưa trả về nội dung logs cho phiên này."}</pre>}
      {!selection && <div className="empty screen-empty"><div className="empty-icon"><TerminalSquare size={24}/></div><h3>Chọn notebook để xem logs</h3><p>Logs sẽ xuất hiện tại đây khi Kaggle cung cấp dữ liệu.</p></div>}
      </section></div>
  </>;
}

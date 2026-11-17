"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, RefreshCw, Search, TerminalSquare } from "lucide-react";
import type { Account, SyncData } from "./connector-screens";

type Selection = { account: Account; ref: string; title: string };
type LogResult = { ref: string; content: string; truncated: boolean; fetched_at: string };
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
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [liveStatus, setLiveStatus] = useState("");
  const [liveTrimmed, setLiveTrimmed] = useState(false);
  const liveController = useRef<AbortController | null>(null);
  const liveSize = useRef(0);
  const requestId = useRef(0);
  useEffect(() => () => { liveController.current?.abort(); requestId.current++; }, []);
  const notebooks = accounts.flatMap(account => (data[account.id]?.notebooks ?? []).flatMap(item => {
    const ref = typeof item.ref === "string" ? item.ref : "";
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref)) return [];
    return [{ account, ref, title: typeof item.title === "string" ? item.title : ref }];
  }));
  const filtered = notebooks.filter(item => `${item.title} ${item.ref} ${item.account.label}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  async function load(item: Selection) {
    const id = ++requestId.current;
    liveController.current?.abort(); liveController.current = null; setLive(false); setLiveText(""); setLiveStatus(""); setLiveTrimmed(false);
    setSelection(item); setResult(null); setError(""); setLoading(true);
    try {
      const response = await fetch(`${API}/api/accounts/${item.account.id}/notebook-logs?ref=${encodeURIComponent(item.ref)}`, { cache: "no-store" });
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
      if (!response.ok || !response.body) throw new Error("Không thể mở luồng logs. Hãy thử lại.");
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
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Không thể theo dõi logs."); }
    finally { if (liveController.current === controller) { liveController.current = null; setLive(false); } }
  }
  function stop() { liveController.current?.abort(); liveController.current = null; setLive(false); setLiveStatus("Đã dừng theo dõi."); }

  return <>
    <div className="heading screen-heading"><div><div className="eyebrow"><span /> THEO DÕI</div><h1>Logs & hoạt động</h1><p>Chọn notebook để xem logs của phiên gần nhất trên Kaggle.</p></div></div>
    <div className="info-banner"><TerminalSquare size={18} /><div><b>Logs và theo dõi trực tiếp</b><p>Chọn notebook để xem bản chụp hoặc theo dõi logs trực tiếp khi Kaggle cung cấp.</p></div></div>
    <div className="logs-grid"><section className="panel logs-list-panel"><div className="panel-heading"><div><h2>Notebook</h2><p>Danh sách từ các tài khoản đã đồng bộ.</p></div></div>
      {notebooks.length > 0 && <label className="log-search"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm notebook" aria-label="Tìm notebook" /></label>}
      <div className="logs-list">{filtered.map(item => <button key={`${item.account.id}:${item.ref}`} className={`log-notebook ${selection?.account.id === item.account.id && selection.ref === item.ref ? "selected" : ""}`} onClick={() => void load(item)}><BookOpen size={18}/><span><b>{item.title}</b><small>{item.account.label} · {item.ref}</small></span></button>)}
      {notebooks.length === 0 && <div className="empty screen-empty"><div className="empty-icon"><BookOpen size={23}/></div><h3>Chưa có notebook</h3><p>Đồng bộ tài khoản để tải danh sách notebook vào phiên làm việc.</p><button className="secondary" onClick={navigate}>Đến trang đồng bộ</button></div>}
      {notebooks.length > 0 && filtered.length === 0 && <div className="empty">Không tìm thấy notebook phù hợp.</div>}</div></section>
      <section className="panel log-viewer"><div className="panel-heading"><div><h2>{selection?.title ?? "Trình xem logs"}</h2><p>{selection ? `${selection.account.label} · ${selection.ref}` : "Chọn một notebook từ danh sách."}</p></div>{selection && <button className="secondary" disabled={loading} onClick={() => void load(selection)}><RefreshCw size={15}/> Làm mới</button>}</div>
      {selection && <div className="log-controls"><button className="secondary" disabled={loading} onClick={live ? stop : () => void follow()}>{live ? "Dừng theo dõi" : "Theo dõi trực tiếp"}</button><span>{liveStatus}</span></div>}
      {selection && <div className="log-meta">{liveStatus ? (liveTrimmed ? "Chỉ giữ phần logs mới nhất trong trình duyệt." : "") : loading ? "Đang tải logs..." : result ? `Đã tải lúc ${new Date(result.fetched_at).toLocaleString("vi-VN")}` : ""}{!liveStatus && result?.truncated && " · Chỉ hiển thị 256 KB cuối"}</div>}
      {error && <div className="alert error log-alert" role="alert">{error}</div>}
      {(result || liveStatus) && <pre className="log-content">{liveStatus ? (liveText || "Đang chờ logs từ Kaggle...") : result?.content ? formatLog(result.content) : "Kaggle chưa trả về nội dung logs cho phiên này."}</pre>}
      {!selection && <div className="empty screen-empty"><div className="empty-icon"><TerminalSquare size={24}/></div><h3>Chọn notebook để xem logs</h3><p>Logs sẽ xuất hiện tại đây khi Kaggle cung cấp dữ liệu.</p></div>}
      </section></div>
  </>;
}

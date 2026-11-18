"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LIMIT = 256 * 1024;

export function formatLog(content: string) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "object" && item !== null && "data" in item)) {
      return parsed.map(item => `${item.time ? `[${String(item.time)}] ` : ""}${String(item.data ?? "")}`).join("\n");
    }
  } catch { /* Plain text and truncated JSON remain readable as returned. */ }
  return content;
}

/** Reads notebook-logs-stream (SSE re-emitted by the server; Kaggle only streams the latest session) and keeps the newest 256 KB. */
export function useLiveLog(onError: (message: string) => void) {
  const [live, setLive] = useState(false), [text, setText] = useState(""), [status, setStatus] = useState(""), [trimmed, setTrimmed] = useState(false);
  const controller = useRef<AbortController | null>(null), size = useRef(0), errorRef = useRef(onError);
  useEffect(() => { errorRef.current = onError; }, [onError]);
  const reset = useCallback(() => { controller.current?.abort(); controller.current = null; setLive(false); setText(""); setStatus(""); setTrimmed(false); }, []);
  useEffect(() => () => controller.current?.abort(), []);
  const follow = useCallback(async (accountId: number, ref: string) => {
    if (controller.current) return;
    const c = new AbortController(); controller.current = c;
    setLive(true); setText(""); setTrimmed(false); size.current = 0; setStatus("Đang kết nối Kaggle...");
    try {
      const response = await fetch(`/api/accounts/${accountId}/notebook-logs-stream?ref=${encodeURIComponent(ref)}`, { signal: c.signal, cache: "no-store" });
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
          if (kind === "log" && payload.text) { const t = payload.text; size.current += t.length; if (size.current > LIMIT) setTrimmed(true); setStatus("Đang theo dõi trực tiếp"); setText(old => (old + t).slice(-LIMIT)); }
          if (kind === "status" || kind === "done") setStatus(payload.message || "");
          if (kind === "error") { errorRef.current(payload.message || "Không thể theo dõi logs."); setStatus(""); }
        }
      }
    } catch (err) { if (!c.signal.aborted) { setStatus(""); errorRef.current(err instanceof Error ? err.message : "Không thể theo dõi logs."); } }
    finally { if (controller.current === c) { controller.current = null; setLive(false); } }
  }, []);
  const stop = useCallback(() => { controller.current?.abort(); controller.current = null; setLive(false); setStatus("Đã dừng theo dõi."); }, []);
  return { live, text, status, trimmed, follow, stop, reset };
}

/** Log panel for one pushed version: live while it runs, otherwise the stored log of that exact version. */
export default function LiveLog({ accountId, refName, version, active }: { accountId: number; refName: string; version: number | null; active: boolean }) {
  const [error, setError] = useState(""), [snapshot, setSnapshot] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const stream = useLiveLog(setError), { follow, reset } = stream;
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/accounts/${accountId}/notebook-logs?ref=${encodeURIComponent(version ? `${refName}/${version}` : refName)}`, { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Không thể tải logs.");
      setSnapshot(typeof body.content === "string" ? body.content : "");
    } catch (e) { setError(e instanceof Error ? e.message : "Không thể tải logs."); } finally { setLoading(false); }
  }, [accountId, refName, version]);
  useEffect(() => { if (active) void follow(accountId, refName); else { reset(); void load(); } return reset; }, [active, accountId, refName, follow, reset, load]);
  return <div className="rq-log">
    <div className="log-controls">{active
      ? <><button className="secondary" onClick={stream.live ? stream.stop : () => void follow(accountId, refName)}>{stream.live ? "Dừng theo dõi" : "Theo dõi trực tiếp"}</button><a className="secondary rq-stop" href={`https://www.kaggle.com/code/${refName}`} target="_blank" rel="noreferrer" title="Kaggle chưa cho dừng phiên qua API: mở notebook trên Kaggle rồi bấm Cancel/Stop">Dừng chạy ↗</a><span>{stream.status}{stream.trimmed ? " · chỉ giữ phần mới nhất" : ""}</span></>
      : <><button className="secondary" disabled={loading} onClick={() => void load()}>Làm mới</button><span>{loading ? "Đang tải logs..." : version ? `Logs của v${version}` : "Logs phiên gần nhất"}</span></>}</div>
    {error && <div className="alert error log-alert" role="alert">{error}</div>}
    <pre className="log-content">{active ? (stream.text || (stream.status ? "Đang chờ logs từ Kaggle..." : "")) : snapshot === null ? "" : snapshot ? formatLog(snapshot) : "Kaggle chưa trả về nội dung logs cho phiên này."}</pre>
  </div>;
}

"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import { Check, ExternalLink, PlayCircle, X } from "lucide-react";
import NotebookView from "../../notebook-view";
import LiveLog from "../../live-log";
import { ago, machineOf, REQUEST_STATUS, VIA_LABEL, type RunRequest } from "../../run-request-shared";

/** Code cells only, so the diff shows code changes and not notebook JSON noise. */
function codeText(code: string) {
  try {
    const nb = JSON.parse(code) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    if (Array.isArray(nb.cells)) return nb.cells.filter(c => c.cell_type === "code").map(c => Array.isArray(c.source) ? c.source.join("") : c.source ?? "").join("\n\n# ─── cell ───\n");
  } catch { /* a .py script */ }
  return code;
}

export default function RunRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [req, setReq] = useState<RunRequest | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"code" | "diff" | "log">("code"), [base, setBase] = useState<string | null | undefined>(undefined), [baseError, setBaseError] = useState("");
  const [rejecting, setRejecting] = useState(false), [note, setNote] = useState("");
  const load = useCallback(async (path = "?code=1") => {
    const r = await fetch(`/api/run-requests/${encodeURIComponent(id)}${path}`, { cache: "no-store" }), body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? "Vui lòng đăng nhập Research OS trong tab chính rồi tải lại trang này." : typeof body.detail === "string" ? body.detail : "Không thể tải yêu cầu.");
    setReq(old => ({ ...body, code: body.code ?? old?.code })); document.title = `Yêu cầu #${body.id} | AI Research OS`;
  }, [id]);
  useEffect(() => { load().catch(e => setError(e instanceof Error ? e.message : "Không thể tải yêu cầu.")); }, [load]);
  const running = req?.status === "running";
  useEffect(() => { if (!running) return; const t = setInterval(() => { void load("/status").catch(() => {}); }, 30000); return () => clearInterval(t); }, [running, load]);
  useEffect(() => {
    if (tab !== "diff" || base !== undefined || !req) return;
    fetch(`/api/run-requests/${req.id}/base`, { cache: "no-store" }).then(async r => { const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Không lấy được code hiện tại."); setBase(body.code ?? null); }).catch(e => { setBase(null); setBaseError(e instanceof Error ? e.message : "Không lấy được code hiện tại."); });
  }, [tab, base, req]);
  const parts = useMemo(() => req?.code && base !== undefined ? diffLines(base ? codeText(base) : "", codeText(req.code)) : null, [req?.code, base]);

  async function act(path: string, body?: object) {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/run-requests/${req!.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), data = await r.json().catch(() => ({}));
      if (!r.ok) setError(typeof data.detail === "string" ? data.detail : "Thao tác không thành công.");
      await load(); setRejecting(false);
      if (r.ok && path === "approve") setTab("log");
    } catch { setError("Không thể kết nối máy chủ."); } finally { setBusy(false); }
  }

  const name = req ? req.ref ?? req.new_title ?? "" : "";
  return <main className="nb-page">
    <header className="nb-page-head">
      <div className="eyebrow"><span /> YÊU CẦU CHẠY NOTEBOOK</div>
      <h1><PlayCircle size={22} /> {req ? <><span className="rn-id">#{req.id}</span> {name}{req.version ? ` · v${req.version}` : ""}</> : "Đang tải..."}</h1>
      {req && <>
        <p className="rn-meta"><span className={`rq-status s-${req.status}`}>{REQUEST_STATUS[req.status] ?? req.status}</span><span>{req.account_label}</span><span>{machineOf(req)}{req.settings.enable_internet ? " · internet" : ""}</span>{req.idea_id && <a className="rn-link" href={`/docs/${req.idea_id}`} target="_blank" rel="noreferrer">Ý tưởng: {req.idea_title}</a>}{req.ref && <a className="rn-link" href={`https://www.kaggle.com/code/${req.ref}`} target="_blank" rel="noreferrer">Mở Kaggle <ExternalLink size={12} /></a>}{req.run_id && <a className="rn-link" href={`/runs/${req.run_id}/code`} target="_blank" rel="noreferrer">Run #{req.run_id}</a>}</p>
        <p className="rn-muted">{VIA_LABEL[req.requested_via]} · {req.requested_by_name ?? "?"} · {ago(req.created_at)}{req.reviewed_by_name ? ` · duyệt/từ chối bởi ${req.reviewed_by_name}` : ""}</p>
        {req.summary && <blockquote className="rq-summary">{req.summary}</blockquote>}
        {req.review_note && <div className="alert error">Ghi chú khi từ chối: {req.review_note}</div>}
        {req.error && <div className="alert error" role="alert">{req.error}</div>}
        {req.status === "pending" && <div className="rq-actions">
          <button className="primary" disabled={busy} onClick={() => void act("approve")}><Check size={16} /> {busy ? "Đang gửi lên Kaggle..." : "Duyệt & chạy"}</button>
          <button className="secondary" disabled={busy} onClick={() => setRejecting(v => !v)}><X size={16} /> Từ chối…</button>
          {req.can_cancel && req.mine && <button className="secondary" disabled={busy} onClick={() => void act("cancel")}>Hủy yêu cầu</button>}
        </div>}
        {rejecting && <div className="rq-reject"><textarea maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Ghi chú cho AI (vì sao từ chối, cần sửa gì)" /><button className="primary" disabled={busy} onClick={() => void act("reject", { note })}>Gửi từ chối</button></div>}
      </>}
    </header>
    {error && <div className="alert error" role="alert">{error}</div>}
    {req && <>
      <div className="rq-tabs" role="tablist">{([["code", "Code"], ["diff", "So với bản hiện tại"], ["log", "Log"]] as const).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>)}</div>
      {tab === "code" && (req.code ? <NotebookView code={req.code} name={name || `request-${req.id}`} /> : <p className="rn-muted">Code sẽ lấy từ version hiện tại trên Kaggle khi chạy.</p>)}
      {tab === "diff" && (base === undefined ? <p className="rn-muted">Đang lấy code hiện tại trên Kaggle...</p> : <>
        {baseError && <div className="alert error">{baseError}</div>}
        {!req.ref && <p className="rn-muted">Notebook mới: toàn bộ code là phần thêm.</p>}
        {parts && !baseError && <pre className="rq-diff">{parts.map((p, i) => <span key={i} className={p.added ? "add" : p.removed ? "del" : ""}>{p.value.replace(/\n$/, "").split("\n").map(l => `${p.added ? "+ " : p.removed ? "- " : "  "}${l}`).join("\n")}{"\n"}</span>)}</pre>}
      </>)}
      {tab === "log" && (req.ref && (req.status === "running" || req.version) ? <LiveLog accountId={req.account_id} refName={req.ref} version={req.version} active={req.status === "running"} /> : <p className="rn-muted">Chưa chạy nên chưa có log.</p>)}
    </>}
  </main>;
}

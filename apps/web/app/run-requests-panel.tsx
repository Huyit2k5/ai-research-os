"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, PlayCircle, X } from "lucide-react";
import {
  ago,
  machineOf,
  MACHINE_LABEL,
  REQUEST_STATUS,
  settingNotes,
  VIA_LABEL,
  type RunRequest,
} from "./run-request-shared";

async function post(path: string, body: object = {}) {
  const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Thao tác không thành công.");
  return data as RunRequest;
}

/** "Chờ duyệt" / "Đang chạy" tabs of the Thí nghiệm screen. The running tab follows each request every 30 s while visible. */
export default function RequestsPanel({ status, onChange }: { status: "pending" | "running"; onChange: () => void }) {
  const [items, setItems] = useState<RunRequest[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<number | null>(null),
    [rejecting, setRejecting] = useState<number | null>(null),
    [note, setNote] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/run-requests?status=${status}&limit=100`, { cache: "no-store" }),
        body = await r.json();
      if (!r.ok) throw new Error(body.detail);
      setItems(body.items);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Không tải được yêu cầu chạy.");
    }
  }, [status]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => {
      if (document.hidden) return;
      void Promise.all(
        (items ?? []).map((r) => fetch(`/api/run-requests/${r.id}/status`, { cache: "no-store" }).catch(() => null)),
      ).then(() => load());
    }, 30000);
    return () => clearInterval(t);
  }, [status, items, load]);
  async function act(r: RunRequest, path: string, body?: object) {
    setBusy(r.id);
    setError("");
    try {
      await post(`/api/run-requests/${r.id}/${path}`, body);
      setRejecting(null);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Thao tác không thành công.");
    } finally {
      setBusy(null);
      await load();
      onChange();
    }
  }
  return (
    <section className="panel rq-panel">
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {items === null ? (
        <div className="empty">Đang tải...</div>
      ) : items.length === 0 ? (
        <div className="empty">
          {status === "pending" ? "Không có yêu cầu nào chờ duyệt." : "Không có notebook nào đang chạy từ app."}
        </div>
      ) : (
        items.map((r) => (
          <article key={r.id} className="rq-card">
            <div className="rq-card-head">
              <a href={`/run-requests/${r.id}`} target="_blank" rel="noreferrer">
                <b>
                  #{r.id} {r.ref ?? r.new_title}
                </b>
                {r.version ? ` · v${r.version}` : ""} <ExternalLink size={12} />
              </a>
              <span className={`rq-status s-${r.status}`}>{REQUEST_STATUS[r.status] ?? r.status}</span>
            </div>
            <p className="rn-muted">
              {r.account_label} · {machineOf(r)}
              {settingNotes(r).map((n) => (
                <span key={n} className={n.startsWith("⚠") ? "rq-warn" : ""}>
                  {" "}
                  · {n}
                </span>
              ))}
              {r.idea_title ? ` · ý tưởng: ${r.idea_title}` : ""}
            </p>
            <p className="rn-muted">
              {VIA_LABEL[r.requested_via]} · {r.requested_by_name ?? "?"} · {ago(r.created_at)}
            </p>
            {r.summary && (
              <p className="rq-card-summary">{r.summary.length > 280 ? r.summary.slice(0, 280) + "…" : r.summary}</p>
            )}
            {r.error && <p className="sync-error">{r.error}</p>}
            {status === "pending" && (
              <div className="rq-actions">
                <a className="secondary" href={`/run-requests/${r.id}`} target="_blank" rel="noreferrer">
                  Xem code
                </a>
                <button className="primary" disabled={busy === r.id} onClick={() => void act(r, "approve")}>
                  <Check size={15} /> {busy === r.id ? "Đang gửi..." : "Duyệt & chạy"}
                </button>
                <button
                  className="secondary"
                  disabled={busy === r.id}
                  onClick={() => setRejecting(rejecting === r.id ? null : r.id)}
                >
                  <X size={15} /> Từ chối…
                </button>
              </div>
            )}
            {status === "running" && r.ref && (
              <div className="rq-actions">
                <a className="secondary" href={`/run-requests/${r.id}`} target="_blank" rel="noreferrer">
                  Xem log
                </a>
                <a
                  className="secondary rq-stop"
                  href={`https://www.kaggle.com/code/${r.ref}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Kaggle chưa cho dừng phiên qua API: mở notebook trên Kaggle rồi bấm Cancel/Stop"
                >
                  Dừng chạy ↗
                </a>
              </div>
            )}
            {rejecting === r.id && (
              <div className="rq-reject">
                <textarea
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Ghi chú cho AI (vì sao từ chối, cần sửa gì)"
                />
                <button className="primary" disabled={busy === r.id} onClick={() => void act(r, "reject", { note })}>
                  Gửi từ chối
                </button>
              </div>
            )}
          </article>
        ))
      )}
    </section>
  );
}

type Idea = { id: number; title: string };
/** "Chạy" on a notebook: the member pressing it is the reviewer, so it is pushed right away. */
export function RunModal({
  accountId,
  refName,
  title,
  onClose,
}: {
  accountId: number;
  refName: string;
  title: string;
  onClose: () => void;
}) {
  const [machine, setMachine] = useState(""),
    [internet, setInternet] = useState(""),
    [idea, setIdea] = useState(""),
    [ideas, setIdeas] = useState<Idea[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState<RunRequest | null>(null);
  useEffect(() => {
    fetch("/api/docs?kind=idea&limit=200", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setIdeas(Array.isArray(b?.items) ? b.items : []))
      .catch(() => {});
  }, []);
  async function run() {
    setBusy(true);
    setError("");
    try {
      setDone(
        await post("/api/run-requests/run-now", {
          account_id: accountId,
          ref: refName,
          ...(machine ? { machine } : {}),
          ...(internet ? { enable_internet: internet === "on" } : {}),
          ...(idea ? { idea_id: Number(idea) } : {}),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không chạy được.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <div>
            <div className="eyebrow">CHẠY TRÊN KAGGLE</div>
            <h2 id="run-title">
              <PlayCircle size={20} /> {title}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Đóng">
            <X size={19} />
          </button>
        </div>
        <p className="modal-description">
          Chạy lại code của version hiện tại thành version mới. Dataset và cấu hình không đổi trừ khi bạn chọn khác.
        </p>
        {done ? (
          <div className="alert success">
            Đã gửi lên Kaggle{done.version ? ` (v${done.version})` : ""}.{" "}
            <a className="rn-link" href={`/run-requests/${done.id}`} target="_blank" rel="noreferrer">
              Theo dõi log <ExternalLink size={12} />
            </a>
          </div>
        ) : (
          <>
            <label>
              Máy
              <select value={machine} onChange={(e) => setMachine(e.target.value)}>
                <option value="">Giữ như hiện tại</option>
                {Object.entries(MACHINE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Internet
              <select value={internet} onChange={(e) => setInternet(e.target.value)}>
                <option value="">Giữ như hiện tại</option>
                <option value="on">Bật</option>
                <option value="off">Tắt</option>
              </select>
            </label>
            <label>
              Ý tưởng (tùy chọn)
              <select value={idea} onChange={(e) => setIdea(e.target.value)}>
                <option value="">— Không gắn —</option>
                {ideas.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Hủy
              </button>
              <button className="primary" disabled={busy} onClick={() => void run()}>
                {busy ? "Đang gửi lên Kaggle..." : "Chạy"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

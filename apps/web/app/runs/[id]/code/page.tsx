"use client";

import { use, useEffect, useState } from "react";
import { Code2, ExternalLink, PlayCircle } from "lucide-react";
import NotebookView from "../../../notebook-view";

type RunCode = {
  id: number;
  name: string;
  source: string;
  ref: string | null;
  version: number | null;
  code?: string | null;
};

export default function RunCodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [run, setRun] = useState<RunCode | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function rerun() {
    if (!run || !window.confirm("Chạy lại đúng code của run này thành một version mới trên Kaggle?")) return;
    setBusy(true);
    setError("");
    const r = await fetch("/api/run-requests/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: run.id }),
      }).catch(() => null),
      body = await r?.json().catch(() => ({}));
    setBusy(false);
    if (r?.ok) window.location.href = `/run-requests/${body.id}`;
    else setError(typeof body?.detail === "string" ? body.detail : "Không chạy lại được.");
  }
  useEffect(() => {
    fetch(`/api/runs/${encodeURIComponent(id)}?code=1`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Vui lòng đăng nhập Research OS trong tab chính rồi tải lại trang này."
              : typeof body.detail === "string"
                ? body.detail
                : "Không thể tải code.",
          );
        setRun(body);
        document.title = `${body.name} · Code | AI Research OS`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Không thể tải code."));
  }, [id]);
  return (
    <main className="nb-page">
      <header className="nb-page-head">
        <div className="eyebrow">
          <span /> CODE NOTEBOOK
        </div>
        <h1>
          <Code2 size={22} />{" "}
          {run ? (
            <>
              <span className="rn-id">#{run.id}</span> {run.name}
            </>
          ) : (
            "Đang tải..."
          )}
        </h1>
        {run?.ref && (
          <p className="rn-meta">
            <span className="rn-ref">
              {run.ref}
              {run.version ? ` · v${run.version}` : ""}
            </span>
            {run.source === "kaggle" && (
              <a className="rn-link" href={`https://www.kaggle.com/code/${run.ref}`} target="_blank" rel="noreferrer">
                Mở Kaggle <ExternalLink size={12} />
              </a>
            )}
            {run.source === "kaggle" && run.code && (
              <button className="rn-link" disabled={busy} onClick={() => void rerun()}>
                <PlayCircle size={12} /> {busy ? "Đang gửi..." : "Chạy lại version này"}
              </button>
            )}
          </p>
        )}
      </header>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {run &&
        (run.code ? (
          <NotebookView code={run.code} name={run.name} />
        ) : (
          <p className="rn-muted">Không có bản chụp code cho run này.</p>
        ))}
    </main>
  );
}

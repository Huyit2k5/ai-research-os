"use client";

import { useState } from "react";
import { Copy, Download, FolderOpen, Search } from "lucide-react";

type OutputFile = { name: string; url: string };

const fileUrl = (runId: number, name: string) => `/api/runs/${runId}/outputs/file?name=${encodeURIComponent(name)}`;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** "File output" of a Kaggle run: loaded on demand (one Kaggle call), filter, select, download or copy curl commands. */
export default function RunOutputs({ runId }: { runId: number }) {
  const [files, setFiles] = useState<OutputFile[] | null>(null),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState(""),
    [picked, setPicked] = useState<Set<string>>(new Set()),
    [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/runs/${runId}/outputs`, { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Không tải được danh sách file.");
      setFiles(body.files);
      setTruncated(!!body.truncated);
      setPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được danh sách file.");
    } finally {
      setLoading(false);
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = (files ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const chosen = (files ?? []).filter((f) => picked.has(f.name));
  const allShown = shown.length > 0 && shown.every((f) => picked.has(f.name));

  function toggle(name: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function toggleShown() {
    setPicked((p) => {
      const next = new Set(p);
      for (const f of shown) {
        if (allShown) next.delete(f.name);
        else next.add(f.name);
      }
      return next;
    });
  }
  async function downloadChosen() {
    // One same-origin link click per file; the browser asks once to allow multiple downloads.
    for (const f of chosen) {
      const a = document.createElement("a");
      a.href = fileUrl(runId, f.name);
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  function copyCurl() {
    const script = chosen.map((f) => `curl -L --create-dirs -o ${quote(f.name)} ${quote(f.url)}`).join("\n");
    void navigator.clipboard
      ?.writeText(script + "\n")
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => setError("Không sao chép được vào clipboard."));
  }

  return (
    <>
      <div className="rn-section rn-section-row">
        <span>File output{files ? ` (${files.length}${truncated ? "+" : ""})` : ""}</span>
        {files && (
          <button className="rn-link" onClick={() => void load()} disabled={loading}>
            Tải lại danh sách
          </button>
        )}
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {!files ? (
        <button className="secondary rn-code-link" onClick={() => void load()} disabled={loading}>
          <FolderOpen size={14} /> {loading ? "Đang lấy danh sách từ Kaggle..." : "Xem file output"}
        </button>
      ) : files.length === 0 ? (
        <p className="rn-muted">Version này không có file output.</p>
      ) : (
        <div className="rn-outputs">
          <label className="rn-out-filter">
            <Search size={13} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Lọc theo tên hoặc đuôi, ví dụ .csv"
              aria-label="Lọc file output"
            />
          </label>
          <label className="rn-out-row rn-out-all">
            <input type="checkbox" checked={allShown} onChange={toggleShown} disabled={!shown.length} />
            <span>
              Chọn tất cả {needle ? "file đang lọc" : ""} ({shown.length})
            </span>
          </label>
          <ul className="rn-out-list">
            {shown.map((f) => (
              <li key={f.name} className="rn-out-row">
                <input
                  type="checkbox"
                  checked={picked.has(f.name)}
                  onChange={() => toggle(f.name)}
                  aria-label={`Chọn ${f.name}`}
                />
                <a href={fileUrl(runId, f.name)} download title={`Tải ${f.name}`}>
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
          <div className="rn-out-actions">
            <button className="primary" disabled={!chosen.length} onClick={() => void downloadChosen()}>
              <Download size={14} /> Tải {chosen.length} file đã chọn
            </button>
            <button className="secondary" disabled={!chosen.length} onClick={copyCurl}>
              <Copy size={14} /> {copied ? "Đã sao chép" : "Sao chép lệnh curl"}
            </button>
          </div>
          <p className="rn-muted">
            Kaggle không cho biết dung lượng file. File lớn (model, checkpoint) nên tải bằng lệnh curl.
            {truncated ? " Danh sách chưa đủ: notebook có quá nhiều file." : ""}
          </p>
        </div>
      )}
    </>
  );
}

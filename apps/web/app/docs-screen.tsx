"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { FilePlus2, FileText, Lightbulb, Paperclip, Search, Upload, X } from "lucide-react";
import { Markdown } from "./notebook-view";

export type Doc = {
  id: number;
  kind: string;
  title: string;
  status: string | null;
  format: string;
  tags: string[];
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  created_via: "web" | "api";
  created_by: string | null;
  can_delete: boolean;
  paper_count: number;
  run_count: number;
  created_at: string;
  updated_at: string;
};
type Page = { total: number; items: Doc[] };
export const KINDS: Record<string, string> = { idea: "Ý tưởng", report: "Báo cáo", other: "Khác" };
export const IDEA_STATUS: Record<string, string> = { new: "Mới", trying: "Đang thử", chosen: "Đã chọn", dropped: "Bỏ" };
const PAGE = 50;

export async function api<T>(path: string, method = "GET", body?: object): Promise<T> {
  const r = await fetch(path, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.detail === "string" ? data.detail : "Thao tác không thành công.");
  return data as T;
}
const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
export const when = (s: string) =>
  new Date(s).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
export const size = (n: number | null) =>
  n === null
    ? ""
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(0)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`;
const tagsOf = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const openDoc = (id: number) => window.open(`/docs/${id}`, "_blank", "noopener");

/** Upload in three steps so file bytes go straight to the store: reserve → PUT presigned URL → complete. */
async function uploadFile(file: File, f: { kind: string; title: string; tags: string[] }) {
  const start = await api<{ id: number; upload_url: string; headers: Record<string, string> }>(
    "/api/docs/uploads",
    "POST",
    {
      file_name: file.name,
      content_type: file.type,
      size: file.size,
      kind: f.kind,
      ...(f.title ? { title: f.title } : {}),
      tags: f.tags,
    },
  );
  let put: Response;
  try {
    put = await fetch(start.upload_url, { method: "PUT", headers: start.headers, body: file });
  } catch {
    throw new Error("Không gửi được file lên kho. Kho file chưa cho phép tên miền này (CORS) hoặc mất kết nối.");
  }
  if (!put.ok) throw new Error(`Kho file từ chối file (${put.status}).`);
  return api<Doc>(`/api/docs/${start.id}/complete`, "POST");
}

function WriteModal({ close, done }: { close: () => void; done: (d: Doc) => void }) {
  const [title, setTitle] = useState(""),
    [kind, setKind] = useState("idea"),
    [format, setFormat] = useState("markdown"),
    [body, setBody] = useState(""),
    [tags, setTags] = useState(""),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      done(await api<Doc>("/api/docs", "POST", { title, kind, format, body, tags: tagsOf(tags) }));
    } catch (x) {
      setErr(msg(x, "Không lưu được tài liệu."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onClick={close}>
      <div
        className="modal dc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dc-write-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <h2 id="dc-write-title">Viết tài liệu mới</h2>
          <button className="icon-button" onClick={close} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        {err && (
          <div className="alert error" role="alert">
            {err}
          </div>
        )}
        <form onSubmit={submit}>
          <label>
            Tiêu đề
            <input
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ví dụ: Thêm S_obj vào bước rerank"
            />
          </label>
          <div className="dc-row">
            <label>
              Loại
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Định dạng
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="markdown">Markdown</option>
                <option value="html">HTML</option>
              </select>
            </label>
          </div>
          <div className="dc-tabs">
            <button type="button" className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
              Soạn
            </button>
            <button type="button" className={preview ? "on" : ""} onClick={() => setPreview(true)}>
              Xem trước
            </button>
          </div>
          {preview ? (
            <div className="dc-preview">
              {format === "html" ? (
                <iframe sandbox="" srcDoc={body} title="Xem trước HTML" className="dc-frame small" />
              ) : (
                <Markdown src={body} />
              )}
            </div>
          ) : (
            <textarea
              className="dc-body"
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={format === "html" ? "<h1>Báo cáo</h1>…" : "# Ý tưởng\nMô tả, giả thuyết, cách thử…"}
              aria-label="Nội dung"
            />
          )}
          <label>
            Tag
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="phân cách bằng dấu phẩy" />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={close}>
              Hủy
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Đang lưu..." : "Lưu"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UploadModal({ close, done }: { close: () => void; done: (d: Doc) => void }) {
  const [file, setFile] = useState<File | null>(null),
    [kind, setKind] = useState("other"),
    [title, setTitle] = useState(""),
    [tags, setTags] = useState(""),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setErr("File vượt quá 25 MB.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      done(await uploadFile(file, { kind, title: title.trim(), tags: tagsOf(tags) }));
    } catch (x) {
      setErr(msg(x, "Không upload được file."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onClick={busy ? undefined : close}>
      <div
        className="modal dc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dc-up-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <h2 id="dc-up-title">Upload file</h2>
          <button className="icon-button" onClick={close} disabled={busy} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <p className="modal-description">
          HTML, PDF, Word, ảnh… tối đa 25 MB. File được lưu ở kho chung của workspace.
        </p>
        {err && (
          <div className="alert error" role="alert">
            {err}
          </div>
        )}
        <form onSubmit={submit}>
          <label>
            File
            <input
              required
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title) setTitle(f.name);
              }}
            />
          </label>
          <label>
            Tiêu đề
            <input
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mặc định là tên file"
            />
          </label>
          <label>
            Loại
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tag
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="phân cách bằng dấu phẩy" />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={close} disabled={busy}>
              Hủy
            </button>
            <button className="primary" disabled={busy || !file}>
              <Upload size={15} /> {busy ? "Đang upload..." : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DocsScreen() {
  const [items, setItems] = useState<Doc[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [kind, setKind] = useState(""),
    [status, setStatus] = useState(""),
    [q, setQ] = useState(""),
    [tag, setTag] = useState(""),
    [modal, setModal] = useState<"write" | "upload" | null>(null);
  const reqId = useRef(0);
  const qs = useCallback(
    (offset: number) =>
      new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
        q,
        ...(kind ? { kind } : {}),
        ...(kind === "idea" && status ? { status } : {}),
        ...(tag ? { tag } : {}),
      }).toString(),
    [q, kind, status, tag],
  );
  const reload = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError("");
    try {
      const r = await api<Page>(`/api/docs?${qs(0)}`);
      if (id === reqId.current) {
        setItems(r.items);
        setTotal(r.total);
      }
    } catch (e) {
      if (id === reqId.current) setError(msg(e, "Không tải được tài liệu."));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [qs]);
  useEffect(() => {
    const t = setTimeout(() => void reload(), q || tag ? 300 : 0);
    return () => clearTimeout(t);
  }, [reload, q, tag]);
  async function more() {
    setLoading(true);
    try {
      const r = await api<Page>(`/api/docs?${qs(items.length)}`);
      setItems((old) => [...old, ...r.items.filter((n) => !old.some((o) => o.id === n.id))]);
      setTotal(r.total);
    } catch (e) {
      setError(msg(e, "Không tải thêm được."));
    } finally {
      setLoading(false);
    }
  }
  const created = (d: Doc) => {
    setModal(null);
    void reload();
    openDoc(d.id);
  };

  return (
    <div className="dc">
      <div className="heading screen-heading">
        <div>
          <div className="eyebrow">
            <span /> TÀI LIỆU
          </div>
          <h1>Tài liệu</h1>
          <p>
            Ý tưởng, báo cáo và file của workspace. AI viết qua MCP/API, hoặc bạn viết và upload trực tiếp. Bấm vào tài
            liệu để mở ở tab mới.
          </p>
        </div>
        <div className="dc-head-actions">
          <button className="secondary" onClick={() => setModal("upload")}>
            <Upload size={15} /> Upload
          </button>
          <button className="primary" onClick={() => setModal("write")}>
            <FilePlus2 size={16} /> Viết mới
          </button>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Đóng">
            <X size={14} />
          </button>
        </div>
      )}
      <section className="panel dc-toolbar">
        <div className="dc-kinds" role="tablist" aria-label="Loại tài liệu">
          {[["", "Tất cả"], ...Object.entries(KINDS)].map(([k, v]) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? "on" : ""}
              onClick={() => {
                setKind(k);
                setStatus("");
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="dc-filters">
          <label className="dc-search">
            <Search size={15} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm trong tiêu đề và nội dung"
              aria-label="Tìm tài liệu"
            />
          </label>
          {kind === "idea" && (
            <label>
              Trạng thái
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Tất cả</option>
                {Object.entries(IDEA_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Tag
            <input value={tag} onChange={(e) => setTag(e.target.value.trim())} placeholder="vd: tuần-46" />
          </label>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              Danh sách <span className="count">{total}</span>
            </h2>
            <p>Mới cập nhật trước.</p>
          </div>
        </div>
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="dc-table">
              <thead>
                <tr>
                  <th>TÀI LIỆU</th>
                  <th>LOẠI</th>
                  <th>LIÊN KẾT</th>
                  <th>NGƯỜI TẠO</th>
                  <th>CẬP NHẬT</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} onClick={() => openDoc(d.id)} className="dc-rowlink">
                    <td>
                      <button
                        className="dc-title"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDoc(d.id);
                        }}
                      >
                        {d.format === "file" ? (
                          <Paperclip size={15} />
                        ) : d.kind === "idea" ? (
                          <Lightbulb size={15} />
                        ) : (
                          <FileText size={15} />
                        )}
                        <b>{d.title}</b>
                      </button>
                      {d.format === "file" && (
                        <small className="dc-muted">
                          {d.file_name} · {size(d.file_size)}
                        </small>
                      )}
                      {d.tags.length > 0 && (
                        <span className="dc-tags">
                          {d.tags.slice(0, 3).map((t) => (
                            <span key={t} className="dc-tag">
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`dc-kind k-${d.kind}`}>{KINDS[d.kind] ?? d.kind}</span>
                      {d.status && (
                        <span className={`dc-status s-${d.status}`}>{IDEA_STATUS[d.status] ?? d.status}</span>
                      )}
                    </td>
                    <td className="time">
                      {d.paper_count} paper · {d.run_count} run
                    </td>
                    <td className="time">
                      {d.created_by ?? "—"}
                      {d.created_via === "api" && <small className="dc-api">qua MCP/API</small>}
                    </td>
                    <td className="time">{when(d.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && items.length === 0 && <div className="empty">Đang tải...</div>}
        {!loading && total === 0 && (
          <div className="empty">
            <div className="empty-icon">
              <FileText size={22} />
            </div>
            <h3>{q || kind || tag ? "Không có tài liệu khớp bộ lọc" : "Chưa có tài liệu nào"}</h3>
            <p>
              Viết ý tưởng đầu tiên, upload file, hoặc để AI tạo qua tool MCP <code>create_doc</code>.
            </p>
          </div>
        )}
        {items.length < total && (
          <button className="secondary dc-more" disabled={loading} onClick={() => void more()}>
            {loading ? "Đang tải..." : `Tải thêm (${total - items.length} còn lại)`}
          </button>
        )}
      </section>
      {modal === "write" && <WriteModal close={() => setModal(null)} done={created} />}
      {modal === "upload" && <UploadModal close={() => setModal(null)} done={created} />}
    </div>
  );
}

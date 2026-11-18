"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Download, FileText, Pencil, Trash2, X } from "lucide-react";
import { Markdown } from "../../notebook-view";
import { api, IDEA_STATUS, KINDS, size, when, type Doc } from "../../docs-screen";

type Full = Doc & { body: string | null; papers: { id: number; title: string }[]; runs: { id: number; name: string }[] };
const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** HTML from people or AI is shown only inside an opaque, script-less sandbox. */
function Sandboxed({ html, src, title }: { html?: string; src?: string; title: string }) { return <iframe sandbox="" className="dc-frame" title={title} {...(src ? { src } : { srcDoc: html ?? "" })} />; }

function WordView({ id, title }: { id: number; title: string }) {
  const [html, setHtml] = useState<string | null>(null), [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    (async () => {
      // Fetch the presigned URL directly: following /file's cross-origin redirect would send Origin: null and fail CORS.
      const { url } = await api<{ url: string }>(`/api/docs/${id}/file?url=1`);
      const r = await fetch(url); if (!r.ok) throw new Error();
      const mammoth = await import("mammoth");
      const out = await mammoth.convertToHtml({ arrayBuffer: await r.arrayBuffer() });
      if (live) setHtml(out.value);
    })().catch(() => { if (live) setErr("Không hiển thị được file Word; hãy tải file gốc."); });
    return () => { live = false; };
  }, [id]);
  if (err) return <p className="dc-muted">{err}</p>;
  return html === null ? <p className="dc-muted">Đang chuyển file Word…</p> : <Sandboxed html={`<style>body{font:15px/1.6 Arial,sans-serif;color:#203655;margin:24px}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}</style>${html}`} title={title} />;
}

function Viewer({ doc }: { doc: Full }) {
  const file = `/api/docs/${doc.id}/file`;
  if (doc.format === "markdown") return <div className="dc-md"><Markdown src={doc.body ?? ""} /></div>;
  if (doc.format === "html") return <Sandboxed html={doc.body ?? ""} title={doc.title} />;
  if (doc.file_type === "text/html") return <Sandboxed src={file} title={doc.title} />;
  if (doc.file_type === "application/pdf") return <iframe className="dc-frame" src={file} title={doc.title} />;
  if (doc.file_type && INLINE_IMAGES.includes(doc.file_type)) return <img className="dc-img" src={file} alt={doc.title} />;
  if (doc.file_type === DOCX) return <WordView id={doc.id} title={doc.title} />;
  return <p className="dc-muted">Loại file này chưa xem được trên web. <a className="rn-link" href={`${file}?download=1`}>Tải file gốc</a>.</p>;
}

export default function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [doc, setDoc] = useState<Full | null>(null), [error, setError] = useState(""), [info, setInfo] = useState(""), [deleted, setDeleted] = useState(false);
  const [edit, setEdit] = useState<{ title: string; body: string } | null>(null), [tags, setTags] = useState(""), [options, setOptions] = useState<{ papers: { id: number; title: string }[]; runs: { id: number; name: string }[] } | null>(null);
  const load = useCallback(async () => {
    try { const d = await api<Full>(`/api/docs/${encodeURIComponent(id)}`); setDoc(d); setTags(d.tags.join(", ")); document.title = `${d.title} · Tài liệu | AI Research OS`; }
    catch (e) { setError(e instanceof Error && e.message.includes("đăng nhập") ? "Vui lòng đăng nhập Research OS trong tab chính rồi tải lại trang này." : e instanceof Error ? e.message : "Không tải được tài liệu."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function patch(body: object, done: string) { setError(""); setInfo(""); try { const d = await api<Doc>(`/api/docs/${id}`, "PATCH", body); setDoc(old => old && { ...old, ...d }); await load(); setInfo(done); return true; } catch (e) { setError(e instanceof Error ? e.message : "Không lưu được."); return false; } }
  async function pickLinks() { if (options) return; try { const [p, r] = await Promise.all([api<{ items: { id: number; title: string }[] }>("/api/papers?limit=100"), api<{ items: { id: number; name: string }[] }>("/api/runs?limit=100")]); setOptions({ papers: p.items, runs: r.items }); } catch { setError("Không tải được danh sách paper/run."); } }
  async function remove() { if (!doc || !window.confirm(`Xóa “${doc.title}”? ${doc.format === "file" ? "File đã upload cũng bị xóa. " : ""}Không thể hoàn tác.`)) return; try { await api(`/api/docs/${id}`, "DELETE"); setDeleted(true); } catch (e) { setError(e instanceof Error ? e.message : "Không xóa được."); } }

  if (deleted) return <main className="dc-page"><div className="alert success">Đã xóa tài liệu. Bạn có thể đóng tab này.</div></main>;
  return <main className="dc-page">
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError("")} aria-label="Đóng"><X size={14} /></button></div>}
    {info && <div className="alert success" role="status">{info}<button onClick={() => setInfo("")} aria-label="Đóng"><X size={14} /></button></div>}
    {!doc ? !error && <p className="dc-muted">Đang tải...</p> : <>
      <header className="dc-page-head">
        <div className="eyebrow"><span /> {KINDS[doc.kind] ?? doc.kind}</div>
        {edit ? <input className="dc-title-input" value={edit.title} maxLength={300} onChange={e => setEdit({ ...edit, title: e.target.value })} aria-label="Tiêu đề" /> : <h1><FileText size={22} /> {doc.title}</h1>}
        <p className="dc-muted">{doc.created_by ?? "—"}{doc.created_via === "api" && " · qua MCP/API"} · cập nhật {when(doc.updated_at)}{doc.format === "file" && ` · ${doc.file_name} · ${size(doc.file_size)}`}</p>
        <div className="dc-actions">
          {doc.format === "file" && <a className="secondary" href={`/api/docs/${doc.id}/file?download=1`}><Download size={14} /> Tải file gốc</a>}
          {doc.format !== "file" && !edit && <button className="secondary" onClick={() => setEdit({ title: doc.title, body: doc.body ?? "" })}><Pencil size={14} /> Sửa</button>}
          {edit && <><button className="primary" onClick={() => void patch({ title: edit.title, ...(doc.format !== "file" ? { body: edit.body } : {}) }, "Đã lưu.").then(ok => ok && setEdit(null))}>Lưu</button><button className="secondary" onClick={() => setEdit(null)}>Hủy</button></>}
          {doc.can_delete && <button className="secondary danger" onClick={() => void remove()}><Trash2 size={14} /> Xóa</button>}
        </div>
      </header>
      {doc.kind === "idea" && <div className="dc-status-bar" role="group" aria-label="Trạng thái ý tưởng">{Object.entries(IDEA_STATUS).map(([k, v]) => <button key={k} className={`dc-status s-${k} ${doc.status === k ? "on" : ""}`} aria-pressed={doc.status === k} onClick={() => doc.status !== k && void patch({ status: k }, `Đã chuyển sang “${v}”.`)}>{v}</button>)}</div>}
      <section className="dc-viewer">{edit && doc.format !== "file" ? <textarea className="dc-body" rows={20} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} aria-label="Nội dung" /> : <Viewer doc={doc} />}</section>
      <section className="dc-side">
        <div><b>Paper liên kết</b>{doc.papers.length ? doc.papers.map(p => <span key={p.id} className="dc-chip">{p.title}<button onClick={() => void patch({ paper_ids: doc.papers.filter(x => x.id !== p.id).map(x => x.id) }, "Đã gỡ paper.")} aria-label={`Gỡ ${p.title}`}><X size={11} /></button></span>) : <span className="dc-muted">Chưa có</span>}
          <select value="" onFocus={() => void pickLinks()} onChange={e => e.target.value && void patch({ paper_ids: [...doc.papers.map(x => x.id), Number(e.target.value)] }, "Đã liên kết paper.")} aria-label="Thêm paper"><option value="">+ Thêm paper…</option>{options?.papers.filter(p => !doc.papers.some(x => x.id === p.id)).map(p => <option key={p.id} value={p.id}>{p.title.length > 80 ? `${p.title.slice(0, 79)}…` : p.title}</option>)}</select></div>
        <div><b>Run liên kết</b>{doc.runs.length ? doc.runs.map(r => <span key={r.id} className="dc-chip">#{r.id} {r.name}<button onClick={() => void patch({ run_ids: doc.runs.filter(x => x.id !== r.id).map(x => x.id) }, "Đã gỡ run.")} aria-label={`Gỡ run ${r.name}`}><X size={11} /></button></span>) : <span className="dc-muted">Chưa có</span>}
          <select value="" onFocus={() => void pickLinks()} onChange={e => e.target.value && void patch({ run_ids: [...doc.runs.map(x => x.id), Number(e.target.value)] }, "Đã liên kết run.")} aria-label="Thêm run"><option value="">+ Thêm run…</option>{options?.runs.filter(r => !doc.runs.some(x => x.id === r.id)).map(r => <option key={r.id} value={r.id}>#{r.id} {r.name}</option>)}</select></div>
        <form onSubmit={e => { e.preventDefault(); void patch({ tags: tags.split(",").map(t => t.trim()).filter(Boolean) }, "Đã lưu tag."); }}><b>Tag</b><input value={tags} onChange={e => setTags(e.target.value)} placeholder="phân cách bằng dấu phẩy" aria-label="Tag" /><button className="secondary">Lưu tag</button></form>
      </section>
    </>}
  </main>;
}

"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, Check, Copy, Download, GitMerge, KeyRound, Link2, Pencil, Quote, RefreshCw, Search, Tag, Trash2, X } from "lucide-react";

type Candidate = { title: string; authors: string[]; year: number | null; abstract: string | null; doi: string | null; arxiv_id: string | null; openalex_id: string | null; url: string | null; pdf_url: string | null; venue?: string | null; venue_type?: string | null; cited_by_count?: number | null; work_type?: string | null };
type Result = Candidate & { saved_id: number | null };
type Note = { id: number; body: string; created_at: string; author?: string | null; mine?: boolean; can_delete?: boolean };
type Status = "to_read" | "reading" | "read";
/** Papers are shared per workspace: added_by is the member who saved it; only they or a workspace owner/admin may delete (can_delete). */
type Paper = Candidate & { id: number; source: string; created_at: string; read_status: Status; read_count?: number; reading_count?: number; member_count?: number; readers?: { name: string | null; status: string; updated_at: string; mine: boolean }[]; tags: string[]; note_count?: number; notes?: Note[]; added_by?: string | null; can_delete?: boolean };
type Token = { id: number; name: string; created_at: string; last_used_at: string | null; workspace_name: string | null; current: boolean };
const NO_DELETE = "Chỉ người thêm paper hoặc quản trị workspace mới được xóa.";
type Page = { items: Paper[]; total: number };
type TagCount = { tag: string; count: number };
const PAGE = 30;
const STATUS: Record<Status, string> = { to_read: "Cần đọc", reading: "Đang đọc", read: "Đã đọc" };
const WORK_TYPE: Record<string, string> = { article: "Bài báo", "conference-paper": "Bài hội nghị", "proceedings-article": "Bài hội nghị", preprint: "Preprint", review: "Bài tổng quan", "book-chapter": "Chương sách", book: "Sách", dissertation: "Luận án", dataset: "Dataset", report: "Báo cáo", letter: "Thư", editorial: "Xã luận" };
type DupPaper = Paper & { note_count: number };
/** Suggests which copy to keep: a journal/conference version over a preprint, then more citations, then more notes. */
const keepScore = (p: DupPaper) => (p.venue_type ? 1000 : 0) + (p.work_type && p.work_type !== "preprint" ? 500 : 0) + Math.min(p.cited_by_count ?? 0, 400) + p.note_count;
function Cites({ p }: { p: { cited_by_count?: number | null; work_type?: string | null } }) {
  return <>{p.work_type && <span className={`pl-badge ${p.work_type === "preprint" ? "preprint" : ""}`}>{WORK_TYPE[p.work_type] ?? p.work_type}</span>}{typeof p.cited_by_count === "number" && <span className="pl-cites" title="Số lần được trích dẫn (OpenAlex)"><Quote size={11} /> {p.cited_by_count.toLocaleString("vi-VN")}</span>}</>;
}

async function call<T>(path: string, method = "GET", body?: object): Promise<T> {
  const res = await fetch(path, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Thao tác không thành công.");
  return data as T;
}
const authors = (a: string[]) => (a.length > 4 ? `${a.slice(0, 4).join(", ")} và ${a.length - 4} tác giả khác` : a.join(", "));
const isHttp = (u: string | null) => !!u && /^https?:\/\//.test(u);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const resultKey = (p: Candidate) => (p.doi || p.arxiv_id || p.openalex_id || p.title).toLowerCase();
/** Display-only: strips simple LaTeX commands that arXiv abstracts often contain. The stored text is not changed. */
function plain(s: string) {
  let t = s;
  for (let i = 0; i < 3; i++) t = t.replace(/\\(?:textbf|textit|emph|texttt|textrm|textsc|mathbf|mathrm|mathcal)\{([^{}]*)\}/g, "$1").replace(/\\textcolor\{[^{}]*\}\{([^{}]*)\}/g, "$1").replace(/\\url\{([^{}]*)\}/g, "$1");
  return t;
}

function Links({ p }: { p: { url: string | null; pdf_url: string | null } }) {
  if (!isHttp(p.url) && !isHttp(p.pdf_url)) return null;
  return <div className="pl-links">{isHttp(p.url) && <a className="pl-link" href={p.url!} target="_blank" rel="noreferrer">Mở nguồn ↗</a>}{isHttp(p.pdf_url) && <a className="pl-link" href={p.pdf_url!} target="_blank" rel="noreferrer">PDF ↗</a>}</div>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="pl-empty"><div className="pl-empty-icon"><BookOpen size={22} /></div><h3>{title}</h3><p>{text}</p></div>;
}
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`pl-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>;
}

type EditForm = { title: string; authors: string; year: string; venue: string; venue_type: string; doi: string; arxiv_id: string; url: string; pdf_url: string; abstract: string };
const toForm = (p: Paper): EditForm => ({ title: p.title, authors: p.authors.join("\n"), year: p.year ? String(p.year) : "", venue: p.venue ?? "", venue_type: p.venue_type ?? "", doi: p.doi ?? "", arxiv_id: p.arxiv_id ?? "", url: p.url ?? "", pdf_url: p.pdf_url ?? "", abstract: p.abstract ?? "" });

export default function PapersScreen() {
  // Library
  const [saved, setSaved] = useState<Paper[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState(""); const [readers, setReaders] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [dups, setDups] = useState<{ groups: DupPaper[][]; keep: Record<number, number> } | null>(null);
  const [busy, setBusy] = useState("");
  // External search
  const [query, setQuery] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [searchPage, setSearchPage] = useState(1);
  const [lastQuery, setLastQuery] = useState("");
  const [searchNote, setSearchNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [ident, setIdent] = useState("");
  const [importing, setImporting] = useState(false);
  // Detail
  const [open, setOpen] = useState<Paper | null>(null);
  const [noteText, setNoteText] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [edit, setEdit] = useState<EditForm | null>(null);
  const [newTag, setNewTag] = useState("");
  // Misc
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [workspace, setWorkspace] = useState<{ id: string; name: string; role: string } | null>(null);

  const filterQs = useCallback(() => `sort=${sort}&source=${source}&status=${status}&readers=${readers}&tag=${encodeURIComponent(tag)}&q=${encodeURIComponent(filter)}`, [sort, source, status, readers, tag, filter]);
  const reload = useCallback(async () => {
    setLoadingList(true);
    try { const r = await call<Page>(`/api/papers?limit=${PAGE}&offset=0&${filterQs()}`); setSaved(r.items); setTotal(r.total); setSelected(new Set()); } catch (e) { setError(msg(e, "Không thể tải thư viện.")); } finally { setLoadingList(false); }
  }, [filterQs]);
  const loadTags = useCallback(async () => { try { setTags(await call<TagCount[]>("/api/papers/tags")); } catch { /* the tag filter just stays empty */ } }, []);
  // Filter text is debounced; the selects apply immediately.
  useEffect(() => { const t = setTimeout(() => void reload(), filter ? 300 : 0); return () => clearTimeout(t); }, [reload, filter]);
  const loadTokens = useCallback(async () => { try { setTokens(await call<Token[]>("/api/tokens")); } catch (e) { setError(msg(e, "Không thể tải token.")); } }, []);
  useEffect(() => { void loadTokens(); void loadTags(); void call<{ id: string; name: string; role: string }>("/api/workspace").then(setWorkspace).catch(() => {}); }, [loadTokens, loadTags]);

  async function refreshAll() { await Promise.all([reload(), loadTags()]); }
  async function loadMore() {
    setLoadingList(true);
    try { const r = await call<Page>(`/api/papers?limit=${PAGE}&offset=${saved.length}&${filterQs()}`); setSaved(old => [...old, ...r.items.filter(n => !old.some(o => o.id === n.id))]); setTotal(r.total); } catch (e) { setError(msg(e, "Không thể tải thêm.")); } finally { setLoadingList(false); }
  }
  function show(id: string) { setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }
  async function view(p: { id: number }, scroll = false) {
    setError(""); setEditing(null); setEdit(null); setNewTag("");
    try { setOpen(await call<Paper>(`/api/papers/${p.id}`)); if (scroll) show("pl-detail"); } catch (err) { setError(msg(err, "Không thể tải paper.")); }
  }
  /** Applies a PATCH to the open paper and mirrors the result into the list. */
  async function patchOpen(body: object, done?: string) {
    if (!open) return;
    setError(""); setInfo("");
    try {
      const p = await call<Paper>(`/api/papers/${open.id}`, "PATCH", body);
      setOpen(o => o && { ...o, ...p }); setSaved(list => list.map(x => x.id === p.id ? { ...x, ...p } : x));
      if ("tags" in body) void loadTags();
      if (done) setInfo(done);
      return true;
    } catch (err) { setError(msg(err, "Không thể cập nhật paper.")); return false; }
  }

  // ---- External search ----
  async function runSearch(page: number) {
    setSearching(true); setError(""); setInfo(""); setSearchNote("");
    const q = page === 1 ? query : lastQuery;
    try {
      const data = await call<{ results: Result[]; errors: string[] }>(`/api/papers/search?q=${encodeURIComponent(q)}&limit=10&page=${page}&year_from=${yearFrom}&year_to=${yearTo}`);
      setSearchNote(data.errors.join(" ")); setSearchPage(page); setLastQuery(q);
      setResults(old => page === 1 || !old ? data.results : [...old, ...data.results.filter(n => !old.some(o => resultKey(o) === resultKey(n)))]);
      if (page > 1 && data.results.length === 0) setInfo("Không còn kết quả mới.");
    } catch (err) { setError(msg(err, "Không thể tìm kiếm.")); } finally { setSearching(false); }
  }
  async function save(p: Result) {
    setError(""); setInfo("");
    try { const r = await call<{ id: number; created: boolean }>("/api/papers", "POST", p); setResults(old => old && old.map(x => x === p ? { ...x, saved_id: r.id } : x)); if (!r.created) setInfo("Paper này đã có trong thư viện (trùng mã hoặc trùng tiêu đề và năm)."); await refreshAll(); } catch (err) { setError(msg(err, "Không thể lưu.")); }
  }
  async function importIdent(e: FormEvent) {
    e.preventDefault(); setImporting(true); setError(""); setInfo("");
    try {
      const r = await call<{ id: number; title: string; created: boolean }>("/api/papers/import", "POST", { identifier: ident });
      setInfo(r.created ? `Đã lưu: ${r.title}` : `Paper đã có trong thư viện: ${r.title}`); setIdent(""); await refreshAll(); await view(r, true);
    } catch (err) { setError(msg(err, "Không thể nhập paper.")); } finally { setImporting(false); }
  }

  // ---- Paper detail ----
  async function remove(p: Paper) {
    if (!window.confirm(`Xóa “${p.title}” khỏi thư viện? Ghi chú cũng bị xóa.`)) return;
    try { await call(`/api/papers/${p.id}`, "DELETE"); if (open?.id === p.id) setOpen(null); setResults(old => old && old.map(x => x.saved_id === p.id ? { ...x, saved_id: null } : x)); await refreshAll(); } catch (err) { setError(msg(err, "Không thể xóa.")); }
  }
  async function saveEdit(e: FormEvent) {
    e.preventDefault(); if (!edit) return;
    const year = edit.year.trim() ? Number(edit.year) : null;
    if (edit.year.trim() && !(Number.isInteger(year) && year! > 1500 && year! < 2200)) { setError("Năm không hợp lệ."); return; }
    const ok = await patchOpen({ title: edit.title, authors: edit.authors.split("\n").map(a => a.trim()).filter(Boolean), year, venue: edit.venue, venue_type: edit.venue_type || null, doi: edit.doi, arxiv_id: edit.arxiv_id, url: edit.url, pdf_url: edit.pdf_url, abstract: edit.abstract }, "Đã lưu thông tin paper.");
    if (ok) setEdit(null);
  }
  function addTag(e: FormEvent) {
    e.preventDefault(); if (!open) return;
    const t = newTag.trim(); if (!t) return;
    if (open.tags.some(x => x.toLowerCase() === t.toLowerCase())) { setNewTag(""); return; }
    void patchOpen({ tags: [...open.tags, t] }).then(ok => ok && setNewTag(""));
  }
  async function copyBibtex(ids: number[]) {
    try {
      const res = await fetch(`/api/papers/export?inline=1&ids=${ids.join(",")}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text()); setInfo(ids.length === 1 ? "Đã sao chép BibTeX." : `Đã sao chép BibTeX của ${ids.length} paper.`);
    } catch { setError("Không thể sao chép BibTeX. Hãy dùng nút Xuất BibTeX để tải file."); }
  }
  async function addNote(e: FormEvent) {
    e.preventDefault(); if (!open) return;
    try { await call(`/api/papers/${open.id}/notes`, "POST", { body: noteText }); setNoteText(""); await view(open); await reload(); } catch (err) { setError(msg(err, "Không thể thêm ghi chú.")); }
  }
  async function saveNote(e: FormEvent) {
    e.preventDefault(); if (!open || !editing) return;
    try { const n = await call<Note>(`/api/papers/${open.id}/notes?note_id=${editing.id}`, "PATCH", { body: editing.text }); setOpen(o => o && { ...o, notes: o.notes?.map(x => x.id === n.id ? n : x) }); setEditing(null); } catch (err) { setError(msg(err, "Không thể sửa ghi chú.")); }
  }
  async function removeNote(id: number) {
    if (!open) return;
    try { await call(`/api/papers/${open.id}/notes?note_id=${id}`, "DELETE"); await view(open); await reload(); } catch (err) { setError(msg(err, "Không thể xóa ghi chú.")); }
  }

  // ---- Metadata refresh, duplicates, merge ----
  async function refresh(ids: number[]) {
    setBusy("refresh"); setError(""); setInfo("");
    try {
      const r = await call<{ refreshed: number; results: { id: number; changed: string[] }[]; missing: { id: number; title: string }[] }>("/api/papers/refresh", "POST", { ids });
      const changed = r.results.filter(x => x.changed.length).length;
      setInfo(`Đã làm mới ${r.refreshed} paper (${changed} có thay đổi)` + (r.missing.length ? `. OpenAlex không có ${r.missing.length} paper (thiếu DOI/arXiv/OpenAlex ID hoặc chưa được lập chỉ mục).` : "."));
      await reload(); if (open && ids.includes(open.id)) await view(open);
    } catch (err) { setError(msg(err, "Không thể làm mới metadata.")); } finally { setBusy(""); }
  }
  function openMerge(groups: DupPaper[][]) {
    setDups({ groups, keep: Object.fromEntries(groups.map((g, i) => [i, [...g].sort((a, b) => keepScore(b) - keepScore(a))[0].id])) }); show("pl-dups");
  }
  async function findDups() {
    setBusy("dups"); setError(""); setInfo("");
    try { const g = await call<DupPaper[][]>("/api/papers/duplicates"); if (!g.length) { setDups(null); setInfo("Không tìm thấy paper trùng trong thư viện."); } else openMerge(g); } catch (err) { setError(msg(err, "Không thể tìm paper trùng.")); } finally { setBusy(""); }
  }
  async function merge(i: number) {
    if (!dups) return;
    const group = dups.groups[i], keepId = dups.keep[i], keep = group.find(p => p.id === keepId)!, others = group.filter(p => p.id !== keepId);
    if (!window.confirm(`Giữ “${keep.title}” (${keep.year ?? "không rõ năm"}) và gộp ${others.length} bản còn lại vào đó? Ghi chú, tag và liên kết sẽ được chuyển sang; các bản còn lại bị xóa.`)) return;
    setBusy("merge"); setError(""); setInfo("");
    try {
      const r = await call<{ merged: number; notes_moved: number; runs_moved?: number }>("/api/papers/merge", "POST", { keep_id: keepId, merge_ids: others.map(p => p.id) });
      setInfo(`Đã gộp ${r.merged} paper, chuyển ${r.notes_moved} ghi chú${r.runs_moved ? ` và ${r.runs_moved} experiment run` : ""}.`);
      setDups(d => { if (!d) return null; const groups = d.groups.filter((_, j) => j !== i); return groups.length ? { groups, keep: Object.fromEntries(groups.map((g, j) => [j, d.keep[d.groups.indexOf(g)]])) } : null; });
      setResults(old => old && old.map(x => x.saved_id && others.some(o => o.id === x.saved_id) ? { ...x, saved_id: keepId } : x));
      if (open && others.some(o => o.id === open.id)) setOpen(null);
      await refreshAll(); if (open?.id === keepId) await view(open);
    } catch (err) { setError(msg(err, "Không thể gộp paper.")); } finally { setBusy(""); }
  }

  // ---- Bulk ----
  function toggle(id: number) { setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  const allShownSelected = saved.length > 0 && saved.every(p => selected.has(p.id));
  async function bulk(action: string, value?: string) {
    const ids = [...selected]; if (!ids.length) return;
    const blocked = action === "delete" ? ids.filter(id => saved.find(p => p.id === id)?.can_delete === false).length : 0;
    if (action === "delete" && !window.confirm(`Xóa ${ids.length - blocked} paper đã chọn cùng toàn bộ ghi chú? Không thể hoàn tác.${blocked ? `\n${blocked} paper do thành viên khác thêm sẽ được giữ lại.` : ""}`)) return;
    setError(""); setInfo("");
    try {
      const r = await call<{ affected: number; skipped?: number }>("/api/papers/bulk", "POST", { ids, action, value });
      setInfo({ delete: `Đã xóa ${r.affected} paper.${r.skipped ? ` Bỏ qua ${r.skipped} paper do thành viên khác thêm (chỉ người thêm hoặc quản trị workspace mới được xóa).` : ""}`, status: `Đã đổi trạng thái ${r.affected} paper.`, add_tag: `Đã gắn tag cho ${r.affected} paper.`, remove_tag: `Đã gỡ tag khỏi ${r.affected} paper.` }[action] ?? "Đã cập nhật.");
      const gone = action === "delete" ? ids.filter(id => saved.find(p => p.id === id)?.can_delete !== false) : [];
      if (open && gone.includes(open.id)) setOpen(null); else if (open && ids.includes(open.id)) void view(open);
      if (gone.length) setResults(old => old && old.map(x => x.saved_id && gone.includes(x.saved_id) ? { ...x, saved_id: null } : x));
      setBulkTag(""); await refreshAll();
    } catch (err) { setError(msg(err, "Không thể thực hiện thao tác.")); }
  }

  // ---- Tokens ----
  async function createToken(e: FormEvent) {
    e.preventDefault(); setError("");
    try { const t = await call<Token & { token: string }>("/api/tokens", "POST", { name: tokenName }); setNewToken(t.token); setCopied(false); setTokenName(""); await loadTokens(); } catch (err) { setError(msg(err, "Không thể tạo token.")); }
  }
  async function revoke(t: Token) {
    if (!window.confirm(`Thu hồi token “${t.name}”? Client đang dùng token này sẽ mất quyền truy cập.`)) return;
    try { await call(`/api/tokens?id=${t.id}`, "DELETE"); await loadTokens(); } catch (err) { setError(msg(err, "Không thể thu hồi token.")); }
  }
  const mcpUrl = typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp`;
  const filtered = !!filter || !!source || !!status || !!readers || !!tag;
  const exportHref = selected.size ? `/api/papers/export?ids=${[...selected].join(",")}` : `/api/papers/export?${filterQs()}`;
  const years = Array.from({ length: 60 }, (_, i) => String(new Date().getFullYear() - i));

  return <div className="pl">
    <div className="heading screen-heading"><div><div className="eyebrow"><span /> PAPER LIBRARY</div><h1>Thư viện paper</h1><p>Tìm paper trên OpenAlex và arXiv, lưu metadata, phân loại bằng tag, theo dõi trạng thái đọc và xuất BibTeX. Claude cũng có thể làm việc với thư viện qua MCP.</p></div></div>
    {error && <div className="alert error" role="alert">{error}<button className="pl-alert-x" onClick={() => setError("")} aria-label="Đóng thông báo"><X size={14} /></button></div>}
    {info && <div className="alert pl-info" role="status">{info}<button className="pl-alert-x" onClick={() => setInfo("")} aria-label="Đóng thông báo"><X size={14} /></button></div>}

    <section className="panel">
      <div className="panel-heading"><div><h2>Tìm paper</h2><p>Nguồn: OpenAlex và arXiv, không cần API key.</p></div></div>
      <div className="pl-body">
        <form className="pl-form" onSubmit={e => { e.preventDefault(); void runSearch(1); }}><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Ví dụ: hard negative mining contrastive learning" aria-label="Từ khóa tìm paper" minLength={2} required /><button className="primary" disabled={searching}>{searching ? "Đang tìm..." : "Tìm kiếm"}</button></form>
        <div className="pl-toolbar pl-years">
          <label>Từ năm<select value={yearFrom} onChange={e => setYearFrom(e.target.value)}><option value="">Bất kỳ</option>{years.map(y => <option key={y}>{y}</option>)}</select></label>
          <label>Đến năm<select value={yearTo} onChange={e => setYearTo(e.target.value)}><option value="">Bất kỳ</option>{years.map(y => <option key={y}>{y}</option>)}</select></label>
        </div>
        <form className="pl-form pl-import" onSubmit={importIdent}><Link2 size={16} /><input value={ident} onChange={e => setIdent(e.target.value)} placeholder="Hoặc thêm bằng DOI / arXiv: 10.1145/3695994, 2110.02027, https://arxiv.org/abs/..." aria-label="DOI hoặc arXiv ID" required /><button className="secondary" disabled={importing}>{importing ? "Đang lấy..." : "Thêm"}</button></form>
        {searchNote && <p className="pl-note">{searchNote}</p>}
        {results && <>
          <div className="pl-count">{results.length} kết quả{searchPage > 1 ? ` · đã tải ${searchPage} trang` : ""}</div>
          <div className="pl-results">
            {results.length === 0 && <Empty title="Không tìm thấy paper" text="Thử từ khóa khác, ngắn gọn hơn hoặc nới khoảng năm." />}
            {results.map((p, i) => <article key={`${i}-${resultKey(p)}`} className={`pl-card ${p.saved_id ? "is-saved" : ""}`}>
              <div>
                <h3>{p.title}</h3>
                <div className="pl-meta">{authors(p.authors) && <span>{authors(p.authors)}</span>}{p.year && <span className="pl-badge">{p.year}</span>}{p.venue && <span>{p.venue}</span>}<Cites p={p} />{p.arxiv_id && p.work_type !== "preprint" && <span className="pl-badge">arXiv</span>}</div>
                {p.abstract && <p className="pl-abstract">{plain(p.abstract)}</p>}
                <Links p={p} />
              </div>
              <div className="pl-action">{p.saved_id ? <button className="pl-done" onClick={() => void view({ id: p.saved_id! }, true)} title="Xem paper trong thư viện"><Check size={14} /> Đã lưu · Xem</button> : <button className="secondary" onClick={() => void save(p)}>Lưu</button>}</div>
            </article>)}
            {results.length > 0 && searchPage < 10 && <button className="secondary pl-more" disabled={searching} onClick={() => void runSearch(searchPage + 1)}>{searching ? "Đang tải..." : "Xem thêm kết quả"}</button>}
          </div>
        </>}
      </div>
    </section>

    {dups && <section className="panel pl-dups" id="pl-dups">
      <div className="panel-heading"><div><h2><GitMerge size={16} /> Gộp paper trùng <span className="count">{dups.groups.length}</span></h2><p>Chọn bản giữ lại trong mỗi nhóm. Ghi chú, tag, trạng thái đọc và liên kết experiment được chuyển sang bản giữ lại; trường còn trống được điền từ các bản kia, rồi các bản kia bị xóa.</p></div><button className="icon-button" onClick={() => setDups(null)} aria-label="Đóng"><X size={15} /></button></div>
      <div className="pl-body pl-dup-groups">{dups.groups.map((g, i) => <div key={g.map(p => p.id).join("-")} className="pl-dup-group">
        {g.map(p => <label key={p.id} className={`pl-dup-item ${dups.keep[i] === p.id ? "keep" : ""}`}>
          <input type="radio" name={`keep-${i}`} checked={dups.keep[i] === p.id} onChange={() => setDups({ ...dups, keep: { ...dups.keep, [i]: p.id } })} />
          <span><b>{p.title}</b><span className="pl-meta">{p.year && <span className="pl-badge">{p.year}</span>}{p.venue && <span>{p.venue}</span>}<Cites p={p} />{p.doi && <span>DOI: {p.doi}</span>}{p.arxiv_id && <span>arXiv: {p.arxiv_id}</span>}<span>{p.note_count} ghi chú</span>{p.tags.length > 0 && <span>{p.tags.length} tag</span>}{p.added_by && <span>Thêm bởi {p.added_by}</span>}</span></span>
          {dups.keep[i] === p.id && <span className="pl-keep">Giữ lại</span>}
        </label>)}
        {g.some(p => p.id !== dups.keep[i] && p.can_delete === false) && <p className="pl-note">Gộp sẽ xóa các bản không giữ lại, nhưng có bản do thành viên khác thêm. {NO_DELETE} Hãy giữ lại bản đó hoặc nhờ người thêm gộp.</p>}
        <div className="pl-token-actions"><button className="primary" disabled={busy === "merge" || g.some(p => p.id !== dups.keep[i] && p.can_delete === false)} onClick={() => void merge(i)}>{busy === "merge" ? "Đang gộp..." : `Gộp ${g.length} bản thành 1`}</button><button className="secondary" onClick={() => setDups(d => d && d.groups.length > 1 ? { groups: d.groups.filter((_, j) => j !== i), keep: Object.fromEntries(d.groups.filter((_, j) => j !== i).map((gg, j) => [j, d.keep[d.groups.indexOf(gg)]])) } : null)}>Không phải trùng</button></div>
      </div>)}</div>
    </section>}

    <div className="pl-split" id="pl-detail">
      <section className="panel">
        <div className="panel-heading"><div><h2>Đã lưu <span className="count">{total}</span></h2><p>{filtered ? `${total} paper khớp bộ lọc` : workspace ? `Thư viện chung của workspace “${workspace.name}”, mọi thành viên cùng xem và bổ sung.` : "Thư viện chung của workspace."}</p></div><div className="pl-head-actions"><button className="secondary pl-export" disabled={busy === "dups"} onClick={() => void findDups()} title="Tìm các bản trùng, ví dụ preprint và bản tạp chí"><GitMerge size={14} /> {busy === "dups" ? "Đang tìm..." : "Tìm trùng"}</button><a className="secondary pl-export" href={exportHref} download><Download size={14} /> {selected.size ? `BibTeX (${selected.size})` : "Xuất BibTeX"}</a></div></div>
        <div className="pl-body">
          <label className="pl-filter"><Search size={15} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Lọc theo tiêu đề, tác giả, abstract" aria-label="Lọc paper đã lưu" /></label>
          <div className="pl-toolbar pl-grid2">
            <label>Trạng thái của bạn<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Tất cả</option>{(Object.keys(STATUS) as Status[]).map(s => <option key={s} value={s}>{STATUS[s]}</option>)}</select></label>
            <label>Người đọc<select value={readers} onChange={e => setReaders(e.target.value)}><option value="">Tất cả</option><option value="none">Chưa ai đọc</option><option value="others">Người khác đã đọc, tôi chưa</option></select></label>
            <label>Tag<select value={tag} onChange={e => setTag(e.target.value)}><option value="">Tất cả</option>{tags.map(t => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}</select></label>
            <label>Sắp xếp<select value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Mới lưu</option><option value="year">Năm xuất bản</option><option value="title">Tên A–Z</option><option value="cited">Trích dẫn nhiều nhất</option></select></label>
            <label>Nguồn<select value={source} onChange={e => setSource(e.target.value)}><option value="">Tất cả</option><option value="manual">Tự lưu</option><option value="mcp">Từ Claude</option></select></label>
          </div>
          {saved.length > 0 && <label className="pl-selectall"><input type="checkbox" checked={allShownSelected} onChange={() => setSelected(allShownSelected ? new Set() : new Set(saved.map(p => p.id)))} /> Chọn tất cả {saved.length} paper đang hiển thị</label>}
          {selected.size > 0 && <div className="pl-bulk" role="region" aria-label="Thao tác hàng loạt">
            <b>Đã chọn {selected.size}</b>
            <select aria-label="Đổi trạng thái" value="" onChange={e => e.target.value && void bulk("status", e.target.value)}><option value="">Đổi trạng thái…</option>{(Object.keys(STATUS) as Status[]).map(s => <option key={s} value={s}>{STATUS[s]}</option>)}</select>
            <form onSubmit={e => { e.preventDefault(); if (bulkTag.trim()) void bulk("add_tag", bulkTag.trim()); }}><input value={bulkTag} onChange={e => setBulkTag(e.target.value)} placeholder="Gắn tag…" aria-label="Tag cho các paper đã chọn" maxLength={40} list="pl-tag-list" /><button className="secondary" disabled={!bulkTag.trim()}>Gắn</button></form>
            {tag && <button className="secondary" onClick={() => void bulk("remove_tag", tag)}>Gỡ tag “{tag}”</button>}
            <button className="secondary" onClick={() => void copyBibtex([...selected])}><Copy size={13} /> BibTeX</button>
            <button className="secondary" disabled={busy === "refresh" || selected.size > 100} onClick={() => void refresh([...selected])} title={selected.size > 100 ? "Tối đa 100 paper mỗi lần" : "Làm mới metadata từ OpenAlex"}><RefreshCw size={13} /> {busy === "refresh" ? "Đang làm mới..." : "Làm mới"}</button>
            {selected.size >= 2 && selected.size <= 20 && <button className="secondary" onClick={() => openMerge([saved.filter(p => selected.has(p.id)).map(p => ({ ...p, note_count: p.note_count ?? 0 }))])}><GitMerge size={13} /> Gộp</button>}
            {(() => { const n = [...selected].filter(id => saved.find(p => p.id === id)?.can_delete !== false).length; return <button className="secondary danger" disabled={!n} title={n < selected.size ? `${selected.size - n} paper do thành viên khác thêm sẽ không bị xóa. ${NO_DELETE}` : undefined} onClick={() => void bulk("delete")}><Trash2 size={13} /> Xóa{n < selected.size ? ` (${n})` : ""}</button>; })()}
            <button className="icon-button" onClick={() => setSelected(new Set())} aria-label="Bỏ chọn"><X size={14} /></button>
          </div>}
          <div className="pl-list">
            {saved.map(p => <div key={p.id} className={`pl-rowwrap ${open?.id === p.id ? "selected" : ""}`}>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Chọn ${p.title}`} />
              <button className="pl-row" onClick={() => void view(p, true)}><b>{p.title}</b><div className="pl-meta"><span className={`pl-status s-${p.read_status}`}>{STATUS[p.read_status]}</span>{(p.member_count ?? 0) > 1 && <span className="pl-readers" title={(p.readers ?? []).filter(r => r.status === "read").map(r => r.name ?? "Ẩn danh").join(", ") || "Chưa ai đọc xong"}>{p.read_count ?? 0}/{p.member_count} đã đọc</span>}{p.year && <span>{p.year}</span>}{typeof p.cited_by_count === "number" && <span className="pl-cites"><Quote size={10} /> {p.cited_by_count.toLocaleString("vi-VN")}</span>}{p.source === "mcp" && <span className="pl-badge claude">Từ Claude</span>}{!!p.note_count && <span>{p.note_count} ghi chú</span>}{p.added_by && <span className="pl-by">Thêm bởi {p.added_by}</span>}</div>{p.tags.length > 0 && <div className="pl-tags small">{p.tags.slice(0, 3).map(t => <span key={t} className="pl-tag">{t}</span>)}{p.tags.length > 3 && <span className="pl-tag more">+{p.tags.length - 3}</span>}</div>}</button>
            </div>)}
            {!loadingList && total === 0 && (filtered ? <Empty title="Không có kết quả" text="Không paper nào khớp bộ lọc." /> : <Empty title="Thư viện trống" text="Tìm paper ở trên rồi bấm Lưu." />)}
            {loadingList && saved.length === 0 && <div className="pl-empty">Đang tải...</div>}
            {saved.length < total && <button className="secondary pl-more" disabled={loadingList} onClick={() => void loadMore()}>{loadingList ? "Đang tải..." : `Tải thêm (${total - saved.length} còn lại)`}</button>}
          </div>
          <datalist id="pl-tag-list">{tags.map(t => <option key={t.tag} value={t.tag} />)}</datalist>
        </div>
      </section>
      <section className="panel">
        {open ? <div className="pl-body" style={{ paddingTop: 22 }}>
          {edit ? <form className="pl-edit" onSubmit={saveEdit}>
            <div className="pl-detail-head"><h2>Sửa thông tin paper</h2></div>
            <Field label="Tiêu đề" wide><input value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} required maxLength={1000} /></Field>
            <Field label="Tác giả (mỗi dòng một người; nhập “Họ, Tên” để giữ đúng thứ tự khi xuất BibTeX)" wide><textarea value={edit.authors} onChange={e => setEdit({ ...edit, authors: e.target.value })} rows={4} /></Field>
            <Field label="Năm"><input value={edit.year} onChange={e => setEdit({ ...edit, year: e.target.value })} inputMode="numeric" maxLength={4} /></Field>
            <Field label="Loại nơi xuất bản"><select value={edit.venue_type} onChange={e => setEdit({ ...edit, venue_type: e.target.value })}><option value="">Không rõ / preprint</option><option value="journal">Tạp chí</option><option value="conference">Hội nghị</option></select></Field>
            <Field label="Tạp chí / hội nghị" wide><input value={edit.venue} onChange={e => setEdit({ ...edit, venue: e.target.value })} maxLength={300} /></Field>
            <Field label="DOI"><input value={edit.doi} onChange={e => setEdit({ ...edit, doi: e.target.value })} maxLength={200} /></Field>
            <Field label="arXiv ID"><input value={edit.arxiv_id} onChange={e => setEdit({ ...edit, arxiv_id: e.target.value })} maxLength={50} /></Field>
            <Field label="Link nguồn" wide><input value={edit.url} onChange={e => setEdit({ ...edit, url: e.target.value })} type="url" /></Field>
            <Field label="Link PDF" wide><input value={edit.pdf_url} onChange={e => setEdit({ ...edit, pdf_url: e.target.value })} type="url" /></Field>
            <Field label="Abstract" wide><textarea value={edit.abstract} onChange={e => setEdit({ ...edit, abstract: e.target.value })} rows={6} maxLength={20000} /></Field>
            <div className="pl-token-actions wide"><button className="primary" type="submit">Lưu thay đổi</button><button className="secondary" type="button" onClick={() => setEdit(null)}>Hủy</button></div>
          </form> : <>
            <div className="pl-detail-head"><h2>{open.title}</h2><div className="pl-head-actions"><button className="secondary" onClick={() => setEdit(toForm(open))}><Pencil size={13} /> Sửa</button>{open.can_delete !== false && <button className="secondary" onClick={() => void remove(open)}><Trash2 size={14} /> Xóa</button>}</div></div>
            <div className="pl-meta">{authors(open.authors) && <span>{authors(open.authors)}</span>}{open.year && <span className="pl-badge">{open.year}</span>}{open.venue && <span>{open.venue}</span>}<Cites p={open} />{open.doi && <span>DOI: {open.doi}</span>}{open.arxiv_id && <span>arXiv: {open.arxiv_id}</span>}</div>
            {open.added_by && <div className="pl-meta pl-by">Thêm bởi {open.added_by} · {new Date(open.created_at).toLocaleDateString("vi-VN")}{open.can_delete === false && " · chỉ người thêm hoặc quản trị workspace mới xóa được"}</div>}
            <div className="pl-links"><Links p={open} /><button className="pl-link" onClick={() => void copyBibtex([open.id])}><Copy size={11} /> Sao chép BibTeX</button><button className="pl-link" disabled={busy === "refresh"} onClick={() => void refresh([open.id])} title="Lấy lại số trích dẫn, loại bài và các trường còn trống từ OpenAlex"><RefreshCw size={11} /> {busy === "refresh" ? "Đang làm mới..." : "Làm mới metadata"}</button></div>
            <div className="pl-section">Trạng thái đọc</div>
            <div className="pl-seg" role="group" aria-label="Trạng thái đọc">{(Object.keys(STATUS) as Status[]).map(s => <button key={s} className={open.read_status === s ? `on s-${s}` : ""} aria-pressed={open.read_status === s} onClick={() => open.read_status !== s && void patchOpen({ read_status: s })}>{STATUS[s]}</button>)}</div>
            {(open.member_count ?? 0) > 1 && <><div className="pl-section">Thành viên đã đọc ({open.read_count ?? 0}/{open.member_count})</div>
              {(open.readers ?? []).length ? <ul className="pl-readers-list">{(open.readers ?? []).map((r, i) => <li key={i}><b>{r.mine ? "Bạn" : r.name ?? "Ẩn danh"}</b> <span className={`pl-status s-${r.status}`}>{STATUS[r.status as Status] ?? r.status}</span> <small>{new Date(r.updated_at).toLocaleDateString("vi-VN")}</small></li>)}</ul> : <p className="pl-hint">Chưa ai trong workspace đánh dấu đang đọc hay đã đọc. Đánh dấu "Đã đọc" kèm một ghi chú để cả nhóm biết bạn rút ra gì.</p>}</>}
            <div className="pl-section">Tag</div>
            <div className="pl-tags">{open.tags.map(t => <span key={t} className="pl-tag">{t}<button onClick={() => void patchOpen({ tags: open.tags.filter(x => x !== t) })} aria-label={`Gỡ tag ${t}`}><X size={11} /></button></span>)}
              <form className="pl-tag-add" onSubmit={addTag}><Tag size={13} /><input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder={open.tags.length ? "Thêm tag" : "Thêm tag, ví dụ: luận văn"} aria-label="Thêm tag" maxLength={40} list="pl-tag-list" /></form></div>
            {open.abstract && <div className="pl-box">{plain(open.abstract)}</div>}
            <div className="pl-section">Ghi chú {open.notes ? `(${open.notes.length})` : ""}</div>
            <form className="pl-form" onSubmit={addNote}><input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Thêm ghi chú về paper này" aria-label="Ghi chú" maxLength={20000} required /><button className="primary">Thêm</button></form>
            <div className="pl-notes">
              {open.notes?.map(n => editing?.id === n.id
                ? <form key={n.id} className="pl-noteitem pl-editing" onSubmit={saveNote}><textarea value={editing.text} onChange={e => setEditing({ id: n.id, text: e.target.value })} maxLength={20000} required autoFocus aria-label="Sửa ghi chú" /><div className="pl-token-actions"><button className="primary" type="submit">Lưu</button><button className="secondary" type="button" onClick={() => setEditing(null)}>Hủy</button></div></form>
                : <div key={n.id} className="pl-noteitem"><div><p>{n.body}</p><small><b>{n.mine ? "Bạn" : n.author ?? "Thành viên đã rời"}</b> · {new Date(n.created_at).toLocaleString("vi-VN")}</small></div><div className="pl-note-actions">{n.mine !== false && <button className="icon-button" onClick={() => setEditing({ id: n.id, text: n.body })} aria-label="Sửa ghi chú"><Pencil size={13} /></button>}{n.can_delete !== false && <button className="icon-button" onClick={() => void removeNote(n.id)} aria-label="Xóa ghi chú"><Trash2 size={13} /></button>}</div></div>)}
              {open.notes?.length === 0 && <p className="pl-note" style={{ color: "#8799ad" }}>Chưa có ghi chú.</p>}
            </div>
          </>}
        </div> : <Empty title="Chọn một paper" text="Xem abstract, trạng thái đọc, tag và ghi chú tại đây." />}
      </section>
    </div>

    <section className="panel">
      <div className="panel-heading"><div><h2><KeyRound size={16} /> Kết nối Claude (MCP)</h2><p>Tạo token cá nhân để Claude tìm và lưu paper vào thư viện này. Token chỉ hiện một lần.</p><p className="pl-hint">Token mới chỉ làm việc trong workspace hiện tại{workspace ? ` (“${workspace.name}”)` : ""}; muốn dùng cho workspace khác, hãy chuyển workspace rồi tạo token mới.</p></div></div>
      <div className="pl-body">
        <form className="pl-form" onSubmit={createToken}><KeyRound size={16} /><input value={tokenName} onChange={e => setTokenName(e.target.value)} placeholder="Tên token, ví dụ: Claude Code" aria-label="Tên token" maxLength={100} required /><button className="primary">Tạo token</button></form>
        {newToken && <div className="pl-token-new" role="status">
          <b>Sao chép token ngay, sẽ không hiển thị lại</b>
          <pre className="pl-code">{newToken}</pre>
          <pre className="pl-code">{`claude mcp add --transport http research-os ${mcpUrl} --header "Authorization: Bearer ${newToken}"`}</pre>
          <div className="pl-token-actions"><button className="secondary" onClick={() => { void navigator.clipboard?.writeText(newToken).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Đã sao chép" : "Sao chép token"}</button><button className="secondary" onClick={() => setNewToken("")}>Đã lưu, ẩn</button></div>
        </div>}
        <div className="pl-tokens">
          {tokens?.map(t => <div key={t.id} className="pl-token"><div className="pl-token-icon"><KeyRound size={16} /></div><div><b>{t.name}</b><small><span className={`pl-ws ${t.current ? "current" : ""}`}>Workspace: {t.workspace_name ?? "chưa gắn"}{t.current ? " (hiện tại)" : ""}</span> · Tạo {new Date(t.created_at).toLocaleDateString("vi-VN")} · {t.last_used_at ? `dùng lần cuối ${new Date(t.last_used_at).toLocaleString("vi-VN")}` : "chưa dùng"}</small></div><button className="secondary" onClick={() => void revoke(t)}>Thu hồi</button></div>)}
          {tokens?.length === 0 && !newToken && <Empty title="Chưa có token" text="Tạo token để kết nối Claude với thư viện." />}
        </div>
      </div>
    </section>
  </div>;
}

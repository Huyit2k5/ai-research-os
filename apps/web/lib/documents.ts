import "server-only";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { AppError, db } from "./server";
import { initExperiments } from "./experiments";
import { rateLimit } from "./papers";
import { deleteObject, headObject, presignGet, presignPut, storageConfigured } from "./storage";
import { canManage, type Scope } from "./workspace";

let ready: Promise<unknown> | undefined;
/** Workspace documents (ideas, reports, other). Text docs keep their body here; uploaded files live in S3 (lib/storage.ts). */
export function initDocs() {
  ready ??= (async () => { await initExperiments(); await db.query(`
    CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('idea','report','other')), title TEXT NOT NULL, status TEXT CHECK (status IN ('new','trying','chosen','dropped')), format TEXT NOT NULL CHECK (format IN ('markdown','html','file')), body TEXT, file_key TEXT UNIQUE, file_name TEXT, file_type TEXT, file_size BIGINT, upload_state TEXT CHECK (upload_state IN ('pending','ready')), tags TEXT[] NOT NULL DEFAULT '{}', created_via TEXT NOT NULL DEFAULT 'web' CHECK (created_via IN ('web','api')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL);
    CREATE INDEX IF NOT EXISTS documents_ws_idx ON documents(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS documents_tags_idx ON documents USING GIN (tags);
    CREATE TABLE IF NOT EXISTS document_papers (document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE, PRIMARY KEY (document_id, paper_id));
    CREATE TABLE IF NOT EXISTS document_runs (document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, run_id INTEGER NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE, PRIMARY KEY (document_id, run_id));
    -- RLS without policies keeps Supabase's public Data API out; the owning role used here bypasses it.
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY; ALTER TABLE document_papers ENABLE ROW LEVEL SECURITY; ALTER TABLE document_runs ENABLE ROW LEVEL SECURITY`); })().catch(err => { ready = undefined; throw err; });
  return ready;
}

export const DOC_KINDS = ["idea", "report", "other"] as const, IDEA_STATUSES = ["new", "trying", "chosen", "dropped"] as const;
export const MAX_DOCS = 5000, MAX_BODY = 512 * 1024, MAX_TITLE = 300, MAX_LINKS = 50, MAX_FILE = 25 * 1024 * 1024;
/** Served inline from the store; everything else (SVG, Word, …) is forced to download. */
export const INLINE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/html"];
/** Project-wide cap (R2's free 10 GB is for the whole account, shared by every workspace). */
const storageLimit = () => (Number(process.env.STORAGE_LIMIT_MB) > 0 ? Number(process.env.STORAGE_LIMIT_MB) : 9000) * 1024 * 1024;
export type DocRow = { id: number; kind: string; title: string; status: string | null; format: string; tags: string[]; file_name: string | null; file_type: string | null; file_size: number | null; created_via: "web" | "api"; created_by: string | null; can_delete: boolean; paper_count: number; run_count: number; created_at: string; updated_at: string };

const FIELDS = `d.id, d.kind, d.title, d.status, d.format, d.tags, d.file_name, d.file_type, d.file_size::float8 AS file_size, d.created_via, d.created_at, d.updated_at, d.owner_id, u.name AS created_by,
  (SELECT COUNT(*)::int FROM document_papers dp WHERE dp.document_id=d.id) AS paper_count, (SELECT COUNT(*)::int FROM document_runs dr WHERE dr.document_id=d.id) AS run_count`;
const FROM = `documents d LEFT JOIN "user" u ON u.id=d.owner_id`;
const shape = (s: Scope, r: Record<string, unknown>) => { const { owner_id, ...rest } = r; return { ...rest, can_delete: canManage(s, owner_id) } as DocRow; };
export const docId = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new AppError(404, "Không tìm thấy tài liệu."); return n; };
const like = (q: string) => q.trim().slice(0, 200).replace(/[\\%_]/g, "\\$&");

const kindOf = (v: unknown) => { if (!(DOC_KINDS as readonly unknown[]).includes(v)) throw new AppError(422, "Loại tài liệu phải là idea, report hoặc other."); return v as string; };
const statusOf = (v: unknown) => { if (!(IDEA_STATUSES as readonly unknown[]).includes(v)) throw new AppError(422, "Trạng thái ý tưởng phải là new, trying, chosen hoặc dropped."); return v as string; };
const titleOf = (v: unknown) => { const t = typeof v === "string" ? v.trim() : ""; if (!t || t.length > MAX_TITLE) throw new AppError(422, `Tiêu đề phải có từ 1 đến ${MAX_TITLE} ký tự.`); return t; };
const bodyOf = (v: unknown) => { if (typeof v !== "string") throw new AppError(422, "Nội dung phải là văn bản."); if (Buffer.byteLength(v, "utf8") > MAX_BODY) throw new AppError(422, "Nội dung vượt quá 512 KB."); return v; };
const textFormat = (v: unknown) => { if (v !== "markdown" && v !== "html") throw new AppError(422, "Định dạng phải là markdown hoặc html."); return v; };
function tagsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AppError(422, "Tag phải là danh sách.");
  const out: string[] = [];
  for (const t of raw) { const v = typeof t === "string" ? t.trim().replace(/\s+/g, " ").slice(0, 40) : ""; if (v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v); }
  if (out.length > 20) throw new AppError(422, "Mỗi tài liệu tối đa 20 tag.");
  return out;
}
function idsOf(raw: unknown, what: string): number[] {
  if (!Array.isArray(raw)) throw new AppError(422, `${what} phải là danh sách id.`);
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(n => !Number.isInteger(n) || n < 1 || n > 2147483647) || ids.length > MAX_LINKS) throw new AppError(422, `${what} không hợp lệ (tối đa ${MAX_LINKS}).`);
  return ids;
}
/** Paper/run links must point into the caller's workspace; replaces the whole set when the field is present. */
async function setLinks(c: PoolClient, s: Scope, docId: number, f: Record<string, unknown>) {
  for (const [field, table, link, col, what] of [["paper_ids", "papers", "document_papers", "paper_id", "paper_ids"], ["run_ids", "experiment_runs", "document_runs", "run_id", "run_ids"]] as const) {
    if (f[field] === undefined) continue;
    const ids = idsOf(f[field], what);
    if (ids.length && Number((await c.query(`SELECT COUNT(*) FROM ${table} WHERE workspace_id=$1 AND id=ANY($2::int[])`, [s.workspaceId, ids])).rows[0].count) !== ids.length) throw new AppError(422, `${what} có id không tồn tại trong workspace.`);
    await c.query(`DELETE FROM ${link} WHERE document_id=$1`, [docId]);
    if (ids.length) await c.query(`INSERT INTO ${link} (document_id, ${col}) SELECT $1, unnest($2::int[])`, [docId, ids]);
  }
}
async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await db.connect();
  try { await c.query("BEGIN"); const out = await fn(c); await c.query("COMMIT"); return out; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
async function row(s: Scope, id: number) {
  const r = (await db.query(`SELECT ${FIELDS} FROM ${FROM} WHERE d.id=$1 AND d.workspace_id=$2 AND (d.upload_state IS NULL OR d.upload_state='ready')`, [id, s.workspaceId])).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy tài liệu.");
  return shape(s, r);
}
async function assertRoom(s: Scope) { if (Number((await db.query("SELECT COUNT(*) FROM documents WHERE workspace_id=$1", [s.workspaceId])).rows[0].count) >= MAX_DOCS) throw new AppError(422, `Workspace đã có tối đa ${MAX_DOCS} tài liệu.`); }
/** Shared by text docs and uploads: kind, title, idea status (ideas default to "new"; other kinds reject a status), tags. */
function baseFields(f: Record<string, unknown>) {
  const kind = kindOf(f.kind);
  if (kind !== "idea" && f.status !== undefined && f.status !== null) throw new AppError(422, "Chỉ ý tưởng mới có trạng thái.");
  return { kind, title: titleOf(f.title), status: kind === "idea" ? (f.status === undefined || f.status === null ? "new" : statusOf(f.status)) : null, tags: f.tags === undefined ? [] : tagsOf(f.tags) };
}

export type ListDocsOpts = { q?: string; kind?: string; status?: string; tag?: string; limit?: number; offset?: number };
export async function listDocs(s: Scope, o: ListDocsOpts = {}) {
  await initDocs();
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50) || 50, 1), 200), offset = Math.max(Math.trunc(o.offset ?? 0) || 0, 0);
  const where = `d.workspace_id=$1 AND (d.upload_state IS NULL OR d.upload_state='ready') AND ($2='' OR d.title ILIKE '%'||$2||'%' OR d.body ILIKE '%'||$2||'%') AND ($3::text IS NULL OR d.kind=$3) AND ($4::text IS NULL OR d.status=$4) AND ($5::text IS NULL OR $5=ANY(d.tags))`;
  const params = [s.workspaceId, like(o.q ?? ""), o.kind || null, o.status || null, o.tag || null];
  const [items, total] = await Promise.all([db.query(`SELECT ${FIELDS} FROM ${FROM} WHERE ${where} ORDER BY d.updated_at DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`, params), db.query(`SELECT COUNT(*) FROM documents d WHERE ${where}`, params)]);
  return { total: Number(total.rows[0].count), offset, limit, items: items.rows.map(r => shape(s, r)) };
}

export async function getDoc(s: Scope, idRaw: unknown) {
  await initDocs();
  const id = docId(idRaw), doc = await row(s, id);
  const [body, papers, runs] = await Promise.all([
    db.query("SELECT body FROM documents WHERE id=$1", [id]),
    db.query("SELECT p.id, p.title FROM document_papers dp JOIN papers p ON p.id=dp.paper_id WHERE dp.document_id=$1 ORDER BY p.title", [id]),
    db.query("SELECT r.id, r.name FROM document_runs dr JOIN experiment_runs r ON r.id=dr.run_id WHERE dr.document_id=$1 ORDER BY r.id DESC", [id])]);
  return { ...doc, body: body.rows[0]?.body ?? null, papers: papers.rows as { id: number; title: string }[], runs: runs.rows as { id: number; name: string }[] };
}

export async function createTextDoc(s: Scope, via: "web" | "api", f: Record<string, unknown>) {
  await initDocs();
  const b = baseFields(f), format = textFormat(f.format), body = bodyOf(f.body ?? "");
  await assertRoom(s);
  const id = await tx(async c => {
    const id = (await c.query("INSERT INTO documents (workspace_id, owner_id, kind, title, status, format, body, tags, created_via, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2) RETURNING id", [s.workspaceId, s.userId, b.kind, b.title, b.status, format, body, b.tags, via])).rows[0].id as number;
    await setLinks(c, s, id, f);
    return id;
  });
  return row(s, id);
}

/** Changes only the fields present. Moving away from `idea` clears the status; moving to `idea` starts at "new". */
export async function updateDoc(s: Scope, idRaw: unknown, f: Record<string, unknown>) {
  await initDocs();
  const id = docId(idRaw), cur = await row(s, id);
  const kind = f.kind === undefined ? cur.kind : kindOf(f.kind);
  let status = kind === "idea" ? (cur.status ?? "new") : null;
  if (f.status !== undefined) { if (kind !== "idea") { if (f.status !== null) throw new AppError(422, "Chỉ ý tưởng mới có trạng thái."); } else status = statusOf(f.status); }
  if ((f.body !== undefined || f.format !== undefined) && cur.format === "file") throw new AppError(422, "Tài liệu dạng file không sửa nội dung được; hãy upload file mới.");
  const title = f.title === undefined ? undefined : titleOf(f.title), body = f.body === undefined ? undefined : bodyOf(f.body), format = f.format === undefined ? undefined : textFormat(f.format), tags = f.tags === undefined ? undefined : tagsOf(f.tags);
  await tx(async c => {
    await c.query("UPDATE documents SET kind=$3, status=$4, title=COALESCE($5,title), body=COALESCE($6,body), format=COALESCE($7,format), tags=COALESCE($8,tags), updated_at=NOW(), updated_by=$9 WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId, kind, status, title ?? null, body ?? null, format ?? null, tags ?? null, s.userId]);
    await setLinks(c, s, id, f);
  });
  return row(s, id);
}

/** Creator or workspace owner/admin. Returns the object key so the caller can delete the stored file. */
export async function deleteDoc(s: Scope, idRaw: unknown) {
  await initDocs();
  const id = docId(idRaw);
  const r = (await db.query("SELECT owner_id, file_key FROM documents WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy tài liệu.");
  if (!canManage(s, r.owner_id)) throw new AppError(403, "Chỉ người tạo tài liệu hoặc quản trị workspace mới được xóa.");
  await db.query("DELETE FROM documents WHERE id=$1", [id]);
  return { file_key: r.file_key as string | null };
}

const mimeOf = (v: unknown) => { const t = typeof v === "string" ? v.split(";")[0].trim().toLowerCase() : ""; return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) && t.length <= 255 ? t : "application/octet-stream"; };
const fileNameOf = (v: unknown) => { const n = typeof v === "string" ? (v.split(/[\\/]/).pop() ?? "").trim().slice(0, 255) : ""; if (!n) throw new AppError(422, "Tên file không hợp lệ."); return n; };
const dropObject = (key: string) => deleteObject(key).catch(e => console.error("storage delete failed:", e instanceof Error ? e.message : e));

/** Step 1 of an upload: checks limits, reserves a pending row and returns a presigned PUT bound to type + size. */
export async function startUpload(s: Scope, via: "web" | "api", f: Record<string, unknown>) {
  await initDocs();
  if (!storageConfigured()) throw new AppError(503, "Chưa cấu hình kho file nên chưa upload được.");
  const fileName = fileNameOf(f.file_name), type = mimeOf(f.content_type), size = Number(f.size);
  if (!Number.isInteger(size) || size < 1) throw new AppError(422, "File rỗng hoặc dung lượng không hợp lệ.");
  if (size > MAX_FILE) throw new AppError(413, "File vượt quá 25 MB.");
  const b = baseFields({ ...f, kind: f.kind ?? "other", title: f.title ?? fileName.slice(0, MAX_TITLE) });
  await rateLimit(s.userId, "doc-upload", 30, 60);
  // Uploads abandoned for over an hour are swept here, so they stop counting toward the limit.
  for (const old of (await db.query("DELETE FROM documents WHERE upload_state='pending' AND created_at < NOW() - INTERVAL '1 hour' RETURNING file_key")).rows) void dropObject(old.file_key);
  await assertRoom(s);
  const used = Number((await db.query("SELECT COALESCE(SUM(file_size),0)::float8 AS n FROM documents")).rows[0].n);
  if (used + size > storageLimit()) throw new AppError(413, "Kho file đã gần đầy; hãy xóa bớt file cũ.");
  const key = `ws/${s.workspaceId}/${randomUUID()}`;
  const id = await tx(async c => {
    const id = (await c.query("INSERT INTO documents (workspace_id, owner_id, kind, title, status, format, file_key, file_name, file_type, file_size, upload_state, tags, created_via, updated_by) VALUES ($1,$2,$3,$4,$5,'file',$6,$7,$8,$9,'pending',$10,$11,$2) RETURNING id", [s.workspaceId, s.userId, b.kind, b.title, b.status, key, fileName, type, size, b.tags, via])).rows[0].id as number;
    await setLinks(c, s, id, f);
    return id;
  });
  const put = await presignPut(key, type, size);
  return { id, upload_url: put.url, headers: put.headers };
}

/** Step 3: the stored object must match the declared size and type, otherwise both the object and the row are removed. */
export async function completeUpload(s: Scope, idRaw: unknown) {
  await initDocs();
  const id = docId(idRaw);
  const r = (await db.query("SELECT file_key, file_size::float8 AS file_size, file_type FROM documents WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 AND upload_state='pending'", [id, s.workspaceId, s.userId])).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy upload đang chờ.");
  const head = await headObject(r.file_key);
  if (!head || head.size !== r.file_size || head.contentType !== r.file_type) {
    if (head) await dropObject(r.file_key);
    await db.query("DELETE FROM documents WHERE id=$1", [id]);
    throw new AppError(422, head ? "File đã tải lên không khớp dung lượng hoặc loại đã khai báo." : "Chưa thấy file trên kho; hãy upload lại.");
  }
  await db.query("UPDATE documents SET upload_state='ready', updated_at=NOW() WHERE id=$1", [id]);
  return row(s, id);
}

/** Short-lived presigned GET; inline only for INLINE_TYPES unless a download is requested. */
export async function fileUrl(s: Scope, idRaw: unknown, download: boolean) {
  await initDocs();
  const r = (await db.query("SELECT file_key, file_name, file_type FROM documents WHERE id=$1 AND workspace_id=$2 AND format='file' AND upload_state='ready'", [docId(idRaw), s.workspaceId])).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy file.");
  // Browsers guess a legacy charset for text without one, garbling Vietnamese; UTF-8 is what our users and AI tools write.
  const contentType = r.file_type.startsWith("text/") ? `${r.file_type}; charset=utf-8` : r.file_type;
  return presignGet(r.file_key, { fileName: r.file_name, contentType, inline: !download && INLINE_TYPES.includes(r.file_type) });
}

/** Deletes the row, then the stored file (a failed object delete only leaves an orphan, it never blocks the user). */
export async function deleteDocAndFile(s: Scope, idRaw: unknown) {
  const { file_key } = await deleteDoc(s, idRaw);
  if (file_key) await dropObject(file_key);
}

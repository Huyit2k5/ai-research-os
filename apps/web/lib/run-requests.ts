import "server-only";
import { AppError, db, decryptToken, kaggleCall, normalizeQuota } from "./server";
import { initDocs } from "./documents";
import { captureRun, TERMINAL } from "./experiments";
import { rateLimit } from "./papers";
import { buildSaveKernelBody, parseSettings, savedRef, validateCode, type PushSettings } from "./save-kernel";
import { canManage, type Scope } from "./workspace";

let ready: Promise<unknown> | undefined;
/** Proposed Kaggle runs. AI (token/MCP) only creates `pending` rows; approval happens on the web session (see approveRequest). */
export function initRunRequests() {
  ready ??= (async () => { await initDocs(); await db.query(`
    CREATE TABLE IF NOT EXISTS run_requests (id SERIAL PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, account_id INTEGER NOT NULL REFERENCES compute_accounts(id) ON DELETE CASCADE, ref TEXT, new_title TEXT, kernel_type TEXT NOT NULL CHECK (kernel_type IN ('notebook','script')), code TEXT NOT NULL, settings JSONB NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '', idea_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','running','done','failed','rejected','cancelled','expired')), requested_by TEXT REFERENCES "user"(id) ON DELETE SET NULL, requested_via TEXT NOT NULL CHECK (requested_via IN ('mcp','api','web')),
      reviewed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL, reviewed_at TIMESTAMPTZ, review_note TEXT, version INTEGER, run_id INTEGER REFERENCES experiment_runs(id) ON DELETE SET NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS run_requests_ws_idx ON run_requests(workspace_id, status, created_at DESC);
    ALTER TABLE run_requests ENABLE ROW LEVEL SECURITY`); })().catch(err => { ready = undefined; throw err; });
  return ready;
}

export const MAX_PENDING = 50, MAX_SUMMARY = 4000, MAX_NOTE = 2000, REQUEST_STATUSES = ["pending", "approved", "running", "done", "failed", "rejected", "cancelled", "expired"] as const;
export type RunRequest = { id: number; account_id: number; account_label: string; ref: string | null; new_title: string | null; kernel_type: string; settings: PushSettings; summary: string; idea_id: number | null; idea_title: string | null; status: string; requested_by_name: string | null; requested_via: "mcp" | "api" | "web"; reviewed_by_name: string | null; reviewed_at: string | null; review_note: string | null; version: number | null; run_id: number | null; error: string | null; created_at: string; updated_at: string; mine: boolean; can_cancel: boolean; code?: string };

const FIELDS = `r.id, r.account_id, a.label AS account_label, r.ref, r.new_title, r.kernel_type, r.settings, r.summary, r.idea_id, d.title AS idea_title, r.status, ru.name AS requested_by_name, r.requested_by, r.requested_via, rv.name AS reviewed_by_name, r.reviewed_at, r.review_note, r.version, r.run_id, r.error, r.created_at, r.updated_at`;
const FROM = `run_requests r JOIN compute_accounts a ON a.id=r.account_id LEFT JOIN documents d ON d.id=r.idea_id LEFT JOIN "user" ru ON ru.id=r.requested_by LEFT JOIN "user" rv ON rv.id=r.reviewed_by`;
const shape = (s: Scope, r: Record<string, unknown>): RunRequest => { const { requested_by, ...rest } = r; return { ...rest, mine: requested_by === s.userId, can_cancel: r.status === "pending" && canManage(s, requested_by) } as RunRequest; };
export const reqId = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new AppError(404, "Không tìm thấy yêu cầu chạy."); return n; };
const REF = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const sweep = (workspaceId: string) => db.query("UPDATE run_requests SET status='expired', updated_at=NOW() WHERE workspace_id=$1 AND status='pending' AND created_at < NOW() - INTERVAL '7 days'", [workspaceId]);
const bad = (e: unknown) => new AppError(422, e instanceof Error ? e.message : "Dữ liệu không hợp lệ.");

export async function getRequest(s: Scope, idRaw: unknown, o: { withCode?: boolean } = {}): Promise<RunRequest> {
  await initRunRequests(); await sweep(s.workspaceId);
  const r = (await db.query(`SELECT ${FIELDS}${o.withCode ? ", r.code" : ""} FROM ${FROM} WHERE r.id=$1 AND r.workspace_id=$2`, [reqId(idRaw), s.workspaceId])).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy yêu cầu chạy.");
  return shape(s, r);
}

export async function listRequests(s: Scope, o: { status?: string; idea_id?: number; limit?: number; offset?: number } = {}) {
  await initRunRequests(); await sweep(s.workspaceId);
  if (o.status && !(REQUEST_STATUSES as readonly string[]).includes(o.status)) throw new AppError(422, "Trạng thái không hợp lệ.");
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50) || 50, 1), 200), offset = Math.max(Math.trunc(o.offset ?? 0) || 0, 0);
  const where = "r.workspace_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::int IS NULL OR r.idea_id=$3)", params = [s.workspaceId, o.status || null, o.idea_id ?? null];
  const [items, total, pending] = await Promise.all([db.query(`SELECT ${FIELDS} FROM ${FROM} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit} OFFSET ${offset}`, params), db.query(`SELECT COUNT(*) FROM run_requests r WHERE ${where}`, params), db.query("SELECT COUNT(*) FROM run_requests WHERE workspace_id=$1 AND status='pending'", [s.workspaceId])]);
  return { total: Number(total.rows[0].count), pending: Number(pending.rows[0].count), offset, limit, items: items.rows.map(r => shape(s, r)) };
}

/** Validates everything a later push needs, so a bad request fails here and not at Kaggle. */
export async function createRequest(s: Scope, via: "mcp" | "api" | "web", f: Record<string, unknown>): Promise<RunRequest> {
  await initRunRequests();
  const v = await validated(s, f, false);
  await rateLimit(s.userId, "run-request", 30, 3600);
  if (Number((await db.query("SELECT COUNT(*) FROM run_requests WHERE workspace_id=$1 AND status='pending'", [s.workspaceId])).rows[0].count) >= MAX_PENDING) throw new AppError(429, `Workspace đã có ${MAX_PENDING} yêu cầu chờ duyệt. Hãy duyệt, từ chối hoặc hủy bớt.`);
  const id = (await db.query("INSERT INTO run_requests (workspace_id, account_id, ref, new_title, kernel_type, code, settings, summary, idea_id, requested_by, requested_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id", [s.workspaceId, v.accountId, v.ref, v.newTitle, v.kernelType, v.code, JSON.stringify(v.settings), v.summary, v.ideaId, s.userId, via])).rows[0].id;
  return getRequest(s, id);
}

/** codeFromKaggle: run-now on an existing notebook leaves code empty; push() fills it from GetKernel. */
async function validated(s: Scope, f: Record<string, unknown>, codeFromKaggle: boolean) {
  const accountId = Number(f.account_id);
  const account = Number.isInteger(accountId) && accountId > 0 && accountId <= 2147483647 ? (await db.query("SELECT id, username FROM compute_accounts WHERE id=$1 AND workspace_id=$2", [accountId, s.workspaceId])).rows[0] : undefined;
  if (!account) throw new AppError(422, "account_id không phải kết nối Kaggle của workspace.");
  const kernelType = f.kernel_type ?? "notebook";
  if (kernelType !== "notebook" && kernelType !== "script") throw new AppError(422, "kernel_type phải là notebook hoặc script.");
  let settings: PushSettings, code: string;
  try { settings = parseSettings({ ...(typeof f.settings === "object" && f.settings ? f.settings : {}), ...Object.fromEntries(["machine", "enable_internet", "is_private", "dataset_sources", "competition_sources", "kernel_sources", "model_sources"].filter(k => f[k] !== undefined).map(k => [k, f[k]])) }); code = codeFromKaggle ? "" : validateCode(f.code, kernelType); } catch (e) { throw bad(e); }
  const summary = f.summary === undefined ? "" : typeof f.summary === "string" && f.summary.length <= MAX_SUMMARY ? f.summary.trim() : null;
  if (summary === null) throw new AppError(422, `summary tối đa ${MAX_SUMMARY} ký tự.`);
  const ref = typeof f.ref === "string" && f.ref.trim() ? f.ref.trim() : null, newTitle = typeof f.new_title === "string" && f.new_title.trim() ? f.new_title.trim() : null;
  if (!ref === !newTitle) throw new AppError(422, "Cần đúng một trong hai: ref (notebook có sẵn) hoặc new_title (notebook mới).");
  if (newTitle && (newTitle.length < 5 || newTitle.length > 50)) throw new AppError(422, "new_title phải dài 5–50 ký tự (giới hạn của Kaggle).");
  if (ref) {
    if (!REF.test(ref)) throw new AppError(422, "ref phải có dạng owner/notebook.");
    // The connection's username is only a label, so a notebook it has synced, run or pushed before also counts as its own.
    const known = ref.split("/")[0].toLowerCase() === String(account.username).toLowerCase() || (await db.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM account_sync, jsonb_array_elements(COALESCE(notebooks, '[]')) n WHERE account_id=$1 AND n->>'ref'=$2) OR EXISTS (SELECT 1 FROM experiment_runs WHERE account_id=$1 AND ref=$2) OR EXISTS (SELECT 1 FROM run_requests WHERE account_id=$1 AND ref=$2)`, [account.id, ref])).rows.length > 0;
    if (!known) throw new AppError(422, "Notebook này không thuộc kết nối Kaggle đã chọn. Hãy đồng bộ kết nối hoặc kiểm tra ref.");
  }
  let ideaId: number | null = null;
  if (f.idea_id !== undefined && f.idea_id !== null) {
    ideaId = Number(f.idea_id);
    if (!Number.isInteger(ideaId) || !(await db.query("SELECT 1 FROM documents WHERE id=$1 AND workspace_id=$2 AND kind='idea' AND (upload_state IS NULL OR upload_state='ready')", [ideaId, s.workspaceId])).rows.length) throw new AppError(422, "idea_id phải là một ý tưởng trong workspace.");
  }
  return { accountId: account.id as number, ref, newTitle, kernelType: kernelType as "notebook" | "script", code, settings, summary, ideaId };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Sends an `approved` row to Kaggle. Any failure puts it back to `pending` with the error, since nothing ran. */
async function push(id: number) {
  const r = (await db.query("SELECT r.*, a.credential FROM run_requests r JOIN compute_accounts a ON a.id=r.account_id WHERE r.id=$1 AND r.status='approved'", [id])).rows[0];
  if (!r) throw new AppError(409, "Yêu cầu này không còn ở trạng thái đã duyệt.");
  let sent = false;
  try {
    const token = decryptToken(r.credential);
    let current: Record<string, unknown> | null = null, code: string = r.code, kernelType: "notebook" | "script" = r.kernel_type;
    if (r.ref) {
      const [userName, kernelSlug] = r.ref.split("/"), k = await kaggleCall(token, "GetKernel", { userName, kernelSlug });
      current = isObj(k.metadata) ? k.metadata : null;
      if (!code) { code = isObj(k.blob) && typeof k.blob.source === "string" ? k.blob.source : ""; if (!code) throw new AppError(502, "Kaggle không trả code của version hiện tại."); if (current?.kernelType === "script" || current?.kernelType === "notebook") kernelType = current.kernelType; }
    }
    const body = buildSaveKernelBody({ ref: r.ref, newTitle: r.new_title, kernelType, code, settings: r.settings, current });
    if (body.enableGpu || body.enableTpu) {
      const kind = body.enableTpu ? "TPU" : "GPU", q = normalizeQuota(await kaggleCall(token, "GetAcceleratorQuotaStatistics", {})).find(x => x.resource === kind);
      if (q && parseFloat(q.remaining) <= 0) throw new AppError(409, `Tài khoản đã hết quota ${kind} (làm mới lúc ${q.refreshAt || "?"}). Hãy chọn máy khác hoặc chờ quota.`);
    }
    const saved = await kaggleCall(token, "SaveKernel", body);
    if (typeof saved.error === "string" && saved.error) throw new AppError(502, `Kaggle từ chối: ${saved.error.slice(0, 300)}`);
    sent = true; // from here Kaggle is running it: never go back to pending, or a re-approve would run it twice
    await db.query("UPDATE run_requests SET status='running', ref=$2, version=$3, code=$4, kernel_type=$5, error=NULL, updated_at=NOW() WHERE id=$1", [id, savedRef(saved.ref) ?? r.ref, Number.isInteger(saved.versionNumber) ? saved.versionNumber : null, code, kernelType]);
    if (r.idea_id) await db.query("UPDATE documents SET status='trying', updated_at=NOW() WHERE id=$1 AND kind='idea' AND status='new'", [r.idea_id]);
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError(502, "Không gửi được lên Kaggle.");
    if (sent) { await db.query("UPDATE run_requests SET status='running', updated_at=NOW() WHERE id=$1 AND status='approved'", [id]).catch(() => {}); throw new AppError(500, "Kaggle đã nhận và đang chạy, nhưng lưu trạng thái bị lỗi. Đừng duyệt lại; hãy tải lại trang."); }
    await db.query("UPDATE run_requests SET status='pending', reviewed_by=NULL, reviewed_at=NULL, error=$2, updated_at=NOW() WHERE id=$1", [id, err.message]);
    throw err;
  }
}

export async function approveRequest(s: Scope, idRaw: unknown): Promise<RunRequest> {
  await initRunRequests(); await rateLimit(s.userId, "run-approve", 10, 60); await sweep(s.workspaceId);
  const id = reqId(idRaw);
  // One statement claims the row, so two reviewers clicking at once push only once.
  const claimed = await db.query("UPDATE run_requests SET status='approved', reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status='pending' RETURNING id", [id, s.workspaceId, s.userId]);
  if (!claimed.rows.length) { await getRequest(s, id); throw new AppError(409, "Yêu cầu này không còn chờ duyệt."); }
  await push(id);
  return getRequest(s, id);
}

/** A member presses "Chạy" on the web: they are the reviewer, so the row starts `approved`. */
export async function runNow(s: Scope, f: Record<string, unknown>): Promise<RunRequest> {
  await initRunRequests(); await rateLimit(s.userId, "run-approve", 10, 60);
  let input = f, fromKaggle = true;
  if (f.run_id !== undefined) {
    const run = (await db.query("SELECT account_id, ref, code FROM experiment_runs WHERE id=$1 AND workspace_id=$2", [Number(f.run_id) || 0, s.workspaceId])).rows[0];
    if (!run) throw new AppError(404, "Không tìm thấy run.");
    if (!run.code) throw new AppError(422, "Run này không lưu code, không chạy lại được.");
    if (!run.account_id || !run.ref) throw new AppError(422, "Run này không gắn với notebook Kaggle nào.");
    let notebook = false; try { notebook = Array.isArray(JSON.parse(run.code)?.cells); } catch { /* script source */ }
    input = { ...f, account_id: run.account_id, ref: run.ref, code: run.code, kernel_type: notebook ? "notebook" : "script" }; fromKaggle = false;
  }
  if (fromKaggle && (typeof input.ref !== "string" || !input.ref)) throw new AppError(422, "Cần ref của notebook hoặc run_id.");
  const v = await validated(s, input, fromKaggle);
  const id = (await db.query("INSERT INTO run_requests (workspace_id, account_id, ref, new_title, kernel_type, code, settings, summary, idea_id, requested_by, requested_via, status, reviewed_by, reviewed_at) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,'web','approved',$9,NOW()) RETURNING id", [s.workspaceId, v.accountId, v.ref, v.kernelType, v.code, JSON.stringify(v.settings), v.summary, v.ideaId, s.userId])).rows[0].id;
  await push(id);
  return getRequest(s, id);
}

export async function rejectRequest(s: Scope, idRaw: unknown, note: unknown): Promise<RunRequest> {
  await initRunRequests(); await sweep(s.workspaceId);
  const text = note === undefined || note === null ? "" : typeof note === "string" && note.length <= MAX_NOTE ? note.trim() : null;
  if (text === null) throw new AppError(422, `Ghi chú tối đa ${MAX_NOTE} ký tự.`);
  const id = reqId(idRaw);
  const r = await db.query("UPDATE run_requests SET status='rejected', reviewed_by=$3, reviewed_at=NOW(), review_note=$4, updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status='pending' RETURNING id", [id, s.workspaceId, s.userId, text || null]);
  if (!r.rows.length) { await getRequest(s, id); throw new AppError(409, "Yêu cầu này không còn chờ duyệt."); }
  return getRequest(s, id);
}

export async function cancelRequest(s: Scope, idRaw: unknown): Promise<RunRequest> {
  const cur = await getRequest(s, idRaw);
  const owner = (await db.query("SELECT requested_by FROM run_requests WHERE id=$1", [cur.id])).rows[0]?.requested_by;
  if (!canManage(s, owner)) throw new AppError(403, "Chỉ người gửi yêu cầu hoặc owner/admin được hủy.");
  const r = await db.query("UPDATE run_requests SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING id", [cur.id]);
  if (!r.rows.length) throw new AppError(409, "Yêu cầu này không còn chờ duyệt.");
  return getRequest(s, cur.id);
}

const accountFor = async (s: Scope, accountId: number) => { const a = (await db.query("SELECT id, credential, workspace_id FROM compute_accounts WHERE id=$1 AND workspace_id=$2", [accountId, s.workspaceId])).rows[0]; if (!a) throw new AppError(404, "Không tìm thấy kết nối."); return a as { id: number; credential: string; workspace_id: string }; };

/** Follows a `running` request: on a terminal Kaggle status it captures the run, finishes the request and links the run to the idea.
 *  Kaggle reports the notebook's latest session, so a newer version pushed meanwhile is what gets followed (spec §7). */
export async function refreshRequest(s: Scope, idRaw: unknown): Promise<RunRequest> {
  const r = await getRequest(s, idRaw);
  if (r.status !== "running" || !r.ref) return r;
  const account = await accountFor(s, r.account_id), [userName, kernelSlug] = r.ref.split("/");
  const st = await kaggleCall(decryptToken(account.credential), "GetKernelSessionStatus", { userName, kernelSlug });
  const status = (typeof st.status === "string" ? st.status : "").replace(/^KERNEL_WORKER_STATUS_/, "").toLowerCase() || "unknown", failure = typeof st.failureMessage === "string" ? st.failureMessage : "";
  if (!TERMINAL.has(status)) return r;
  let runId: number | null = null, error = status === "complete" ? null : failure.slice(0, 2000) || `Kaggle kết thúc với trạng thái ${status}.`;
  try {
    const c = await captureRun(s, account, r.ref, { version: r.version ?? undefined, status, failureMessage: failure });
    runId = c.skipped ? (await db.query("SELECT id FROM experiment_runs WHERE account_id=$1 AND ref=$2 AND source='kaggle' AND ($3::int IS NULL OR version=$3) ORDER BY id DESC LIMIT 1", [account.id, r.ref, r.version])).rows[0]?.id ?? null : c.run.id;
  } catch (e) { error = `${error ? error + " · " : ""}Không thu được run: ${e instanceof Error ? e.message : "lỗi"}`; }
  await db.query("UPDATE run_requests SET status=$2, error=$3, updated_at=NOW() WHERE id=$1 AND status='running'", [r.id, status === "complete" ? "done" : "failed", error]);
  if (runId) await linkCapturedRun(s.workspaceId, account.id, r.ref, r.version, runId);
  return getRequest(s, r.id);
}

/** Called after any capture (also from notebook-status): attaches the run to the matching pushed request and to its idea. */
export async function linkCapturedRun(workspaceId: string, accountId: number, ref: string, version: number | null, runId: number) {
  await initRunRequests();
  const rows = (await db.query(`UPDATE run_requests SET run_id=$5, updated_at=NOW() WHERE id IN (SELECT id FROM run_requests WHERE workspace_id=$1 AND account_id=$2 AND ref=$3 AND status IN ('running','done','failed') AND (version=$4 OR ($4::int IS NULL AND status='running')) ORDER BY id DESC LIMIT 1) RETURNING idea_id`, [workspaceId, accountId, ref, version, runId])).rows;
  for (const { idea_id } of rows) if (idea_id) await db.query("INSERT INTO document_runs (document_id, run_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [idea_id, runId]);
}

/** The code of the notebook's current Kaggle version, for the review diff (null for a new notebook). */
export async function currentSource(s: Scope, idRaw: unknown): Promise<{ code: string | null }> {
  const r = await getRequest(s, idRaw);
  if (!r.ref) return { code: null };
  const [userName, kernelSlug] = r.ref.split("/"), k = await kaggleCall(decryptToken((await accountFor(s, r.account_id)).credential), "GetKernel", { userName, kernelSlug });
  return { code: isObj(k.blob) && typeof k.blob.source === "string" ? k.blob.source : null };
}

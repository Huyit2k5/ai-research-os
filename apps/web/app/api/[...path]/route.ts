import { accountById, AppError, db, decryptToken, encryptToken, initialize, kaggleCall, normalizeQuota } from "../../../lib/server";
import { captureRun, initExperiments, TERMINAL } from "../../../lib/experiments";
import { sessionWorkspace } from "../../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const fields = "id, label, username, verified, last_verified_at";
const refPattern = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/[0-9]+)?$/;
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function message(error: unknown) { return error instanceof AppError ? error : new AppError(500, "Không thể xử lý yêu cầu. Kiểm tra cấu hình server."); }
function validateRef(request: Request) { const ref = new URL(request.url).searchParams.get("ref") || ""; if (!refPattern.test(ref)) throw new AppError(422, "Tên notebook không hợp lệ. Hãy dùng owner/notebook."); return ref; }
async function payload(req: Request) { try { return await req.json(); } catch { throw new AppError(400, "Dữ liệu không hợp lệ."); } }
function required(value: unknown, name: string, max: number) { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError(422, `${name} không hợp lệ.`); return value.trim(); }

async function streamLogs(req: Request, token: string, ref: string) {
  const [owner, slug, version] = ref.split("/");
  const url = new URL(`https://api.kaggle.com/v1/kernels/logs/stream/${owner}/${slug}`);
  if (version) url.searchParams.set("versionLabel", version);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (req.signal.aborted) controller.abort();
  let upstream: Response;
  try { upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream, */*" }, signal: controller.signal, cache: "no-store" }); }
  catch { clearTimeout(timeout); throw new AppError(502, "Không thể kết nối luồng logs Kaggle."); }
  if (!upstream.ok || !upstream.body) { clearTimeout(timeout); throw new AppError(502, "Kaggle không mở được logs trực tiếp cho notebook này. Hãy thử nút Làm mới."); }
  const isSSE = (upstream.headers.get("content-type") || "").includes("text/event-stream"), reader = upstream.body.getReader(), encoder = new TextEncoder(), decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      const send = (kind: string, data: object) => out.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        send("status", { message: "Đã kết nối Kaggle." }); let pending = "";
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          const text = decoder.decode(chunk.value, { stream: true });
          if (!isSSE) { pending = (pending + text).slice(-1024 * 1024); continue; }
          pending += text;
          if (pending.length > 1024 * 1024) throw new Error("large event");
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trimStart(); if (data === "END_OF_LOG") continue;
            let rendered = data;
            try { const event = JSON.parse(data); if (event && typeof event.data === "string") rendered = event.data; } catch {}
            if (rendered) send("log", { text: rendered });
          }
        }
        if (!isSSE && pending) {
          let output = pending;
          try { const events: unknown = JSON.parse(pending); if (Array.isArray(events)) output = events.map(event => typeof event?.data === "string" ? event.data : "").join(""); } catch {}
          if (output) send("log", { text: output });
        }
        send("done", { message: "Phiên theo dõi đã kết thúc." });
      } catch { if (!controller.signal.aborted) { try { send("error", { message: "Luồng logs bị gián đoạn. Vui lòng kết nối lại." }); } catch {} } }
      finally { clearTimeout(timeout); try { out.close(); } catch {} }
    },
    cancel() { clearTimeout(timeout); controller.abort(); void reader.cancel(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

async function handler(req: Request, ctx: Context) {
  try {
    const path = (await ctx.params).path, method = req.method;
    const origin = req.headers.get("origin");
    const trustedOrigin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
    if (method !== "GET" && origin && origin !== trustedOrigin) throw new AppError(403, "Nguồn yêu cầu không hợp lệ.");
    if (path[0] === "health" && method === "GET") return json({ status: "ok" });
    if (path[0] !== "accounts" && path[0] !== "workspace") throw new AppError(404, "Không tìm thấy API.");
    await initialize(); await initExperiments();
    // Shared resolver (lib/workspace.ts): active workspace while still a member, else oldest, else a new personal one.
    const scope = await sessionWorkspace(req), ownerId = scope.userId, workspace = { id: scope.workspaceId, name: scope.workspaceName, role: scope.role };
    if (path[0] === "workspace") { if (path.length === 1 && method === "GET") return json(workspace); throw new AppError(404, "Không tìm thấy API."); }
    // Only the first registered user can claim connections created before login was added.
    await db.query('UPDATE compute_accounts SET owner_id=$1, workspace_id=$2 WHERE owner_id IS NULL AND $1=(SELECT id FROM "user" ORDER BY "createdAt", id LIMIT 1)', [ownerId, workspace.id]);
    if (path.length === 1 && method === "GET") return json((await db.query(`SELECT a.id, a.label, a.username, a.verified, a.last_verified_at, u.name AS creator, a.owner_id=$2 AS mine, (a.owner_id=$2 OR $3) AS can_delete FROM compute_accounts a LEFT JOIN "user" u ON u.id=a.owner_id WHERE a.workspace_id=$1 ORDER BY a.id DESC`, [workspace.id, ownerId, ["owner", "admin"].includes(workspace.role)])).rows);
    if (path.length === 1 && method === "POST") {
      const data = await payload(req), label = required(data.label, "Tên kết nối", 100), username = required(data.username, "Username", 100), token = required(data.token, "Token", 10000);
      const result = await db.query(`INSERT INTO compute_accounts (label,username,credential,verified,owner_id,workspace_id) VALUES ($1,$2,$3,false,$4,$5) RETURNING ${fields}`, [label, username, encryptToken(token), ownerId, workspace.id]);
      return json(result.rows[0], 201);
    }
    const account = await accountById(path[1], workspace.id), mine = account.owner_id === ownerId;
    if (path.length === 2 && method === "DELETE") { if (!mine && !["owner", "admin"].includes(workspace.role)) throw new AppError(403, "Chỉ người tạo kết nối hoặc quản trị workspace mới được xóa."); await db.query("DELETE FROM compute_accounts WHERE id=$1", [account.id]); return new Response(null, { status: 204 }); }
    // Any workspace member may use a connection (verify, sync, logs, run capture); the token itself is never returned. Replacing it is limited to the creator and workspace owner/admin.
    if (path[2] === "credential" && method === "PATCH") { if (!mine && !["owner", "admin"].includes(workspace.role)) throw new AppError(403, "Chỉ người tạo kết nối hoặc quản trị workspace mới được đổi token."); const token = required((await payload(req)).token, "Token", 10000); return json((await db.query(`UPDATE compute_accounts SET credential=$1,verified=false,last_verified_at=NULL WHERE id=$2 RETURNING ${fields}`, [encryptToken(token), account.id])).rows[0]); }
    if (path[2] === "verify" && method === "POST") {
      let success = false; try { await kaggleCall(decryptToken(account.credential), "GetAcceleratorQuotaStatistics", {}); success = true; } finally { await db.query("UPDATE compute_accounts SET verified=$1,last_verified_at=NOW() WHERE id=$2", [success, account.id]); }
      return json((await db.query(`SELECT ${fields} FROM compute_accounts WHERE id=$1`, [account.id])).rows[0]);
    }
    if (path[2] === "sync" && method === "POST") {
      const token = decryptToken(account.credential), errors: Record<string, string> = {};
      let quota = null, notebooks = null, notebooks_truncated = false;
      try { quota = normalizeQuota(await kaggleCall(token, "GetAcceleratorQuotaStatistics", {})); } catch (e) { errors.quota = message(e).message; }
      try { const out = await kaggleCall(token, "ListKernels", { group: "PROFILE", pageSize: 100, language: "all", kernelType: "all", outputType: "all", sortBy: "HOTNESS" }); notebooks = Array.isArray(out.kernels) ? out.kernels : []; notebooks_truncated = Boolean(out.nextPageToken); } catch (e) { errors.notebooks = message(e).message; }
      const syncedAt = new Date().toISOString();
      // A failed half keeps the previously stored data instead of erasing it.
      if (quota || notebooks) await db.query(
        `INSERT INTO account_sync (account_id, synced_at, quota, notebooks, notebooks_truncated, errors) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (account_id) DO UPDATE SET synced_at=EXCLUDED.synced_at, quota=COALESCE(EXCLUDED.quota, account_sync.quota), notebooks=COALESCE(EXCLUDED.notebooks, account_sync.notebooks), notebooks_truncated=CASE WHEN EXCLUDED.notebooks IS NULL THEN account_sync.notebooks_truncated ELSE EXCLUDED.notebooks_truncated END, errors=EXCLUDED.errors`,
        [account.id, syncedAt, quota ? JSON.stringify(quota) : null, notebooks ? JSON.stringify(notebooks) : null, notebooks_truncated, JSON.stringify(errors)]);
      if (quota) { await db.query("INSERT INTO quota_snapshots (account_id, quota) VALUES ($1,$2)", [account.id, JSON.stringify(quota)]); await db.query("DELETE FROM quota_snapshots WHERE account_id=$1 AND captured_at < NOW() - INTERVAL '90 days'", [account.id]); }
      const saved = (await db.query("SELECT synced_at, quota, notebooks, notebooks_truncated FROM account_sync WHERE account_id=$1", [account.id])).rows[0];
      return json({ synced_at: saved?.synced_at ?? syncedAt, quota: saved?.quota ?? null, notebooks: saved?.notebooks ?? null, notebooks_truncated: saved?.notebooks_truncated ?? false, errors });
    }
    if (path[2] === "sync" && method === "GET") {
      const saved = (await db.query("SELECT synced_at, quota, notebooks, notebooks_truncated, errors FROM account_sync WHERE account_id=$1", [account.id])).rows[0];
      return json(saved ?? null);
    }
    if (path[2] === "notebook-logs" && method === "GET") { const ref = validateRef(req), [userName, kernelSlug, versionLabel] = ref.split("/"); const result = await kaggleCall(decryptToken(account.credential), "ListKernelSessionOutput", { userName, kernelSlug, ...(versionLabel ? { versionLabel } : {}) }); const bytes = Buffer.from(typeof result.log === "string" ? result.log : "", "utf8"), limit = 256 * 1024; return json({ ref, content: bytes.subarray(-limit).toString("utf8").trim(), truncated: bytes.length > limit, fetched_at: new Date().toISOString() }); }
    if (path[2] === "notebook-status" && method === "GET") {
      const [userName, kernelSlug] = validateRef(req).split("/");
      const result = await kaggleCall(decryptToken(account.credential), "GetKernelSessionStatus", { userName, kernelSlug });
      const raw = typeof result.status === "string" ? result.status : "", status = raw.replace(/^KERNEL_WORKER_STATUS_/, "").toLowerCase() || "unknown", failure_message = typeof result.failureMessage === "string" ? result.failureMessage : "";
      // A finished session is captured into experiment_runs automatically; capture errors never break the status response.
      let run: { id: number; created: boolean; captured_from: unknown } | null = null, capture_error = "";
      if (TERMINAL.has(status)) { try { const c = await captureRun(scope, account,`${userName}/${kernelSlug}`, { status, failureMessage: failure_message }); if (!c.skipped) run = { id: c.run.id, created: c.created, captured_from: c.run.captured_from }; } catch (e) { capture_error = message(e).message; } }
      return json({ status, failure_message, fetched_at: new Date().toISOString(), run, capture_error });
    }
    if (path[2] === "notebook-logs-stream" && method === "GET") return await streamLogs(req, decryptToken(account.credential), validateRef(req));
    throw new AppError(404, "Không tìm thấy API.");
  } catch (error) { const e = message(error); return json({ detail: e.message }, e.status); }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;

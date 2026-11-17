import { accountById, AppError, db, decryptToken, encryptToken, initialize, kaggleCall, normalizeQuota } from "../../../lib/server";

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
    if (method !== "GET" && origin && origin !== new URL(req.url).origin) throw new AppError(403, "Nguồn yêu cầu không hợp lệ.");
    if (path[0] === "health" && method === "GET") return json({ status: "ok" });
    if (path[0] !== "accounts") throw new AppError(404, "Không tìm thấy API.");
    await initialize();
    if (path.length === 1 && method === "GET") return json((await db.query(`SELECT ${fields} FROM compute_accounts ORDER BY id DESC`)).rows);
    if (path.length === 1 && method === "POST") {
      const data = await payload(req), label = required(data.label, "Tên kết nối", 100), username = required(data.username, "Username", 100), token = required(data.token, "Token", 10000);
      const result = await db.query(`INSERT INTO compute_accounts (label,username,credential,verified) VALUES ($1,$2,$3,false) RETURNING ${fields}`, [label, username, encryptToken(token)]);
      return json(result.rows[0], 201);
    }
    const account = await accountById(path[1]);
    if (path.length === 2 && method === "DELETE") { await db.query("DELETE FROM compute_accounts WHERE id=$1", [account.id]); return new Response(null, { status: 204 }); }
    if (path[2] === "credential" && method === "PATCH") { const token = required((await payload(req)).token, "Token", 10000); return json((await db.query(`UPDATE compute_accounts SET credential=$1,verified=false,last_verified_at=NULL WHERE id=$2 RETURNING ${fields}`, [encryptToken(token), account.id])).rows[0]); }
    if (path[2] === "verify" && method === "POST") {
      let success = false; try { await kaggleCall(decryptToken(account.credential), "GetAcceleratorQuotaStatistics", {}); success = true; } finally { await db.query("UPDATE compute_accounts SET verified=$1,last_verified_at=NOW() WHERE id=$2", [success, account.id]); }
      return json((await db.query(`SELECT ${fields} FROM compute_accounts WHERE id=$1`, [account.id])).rows[0]);
    }
    if (path[2] === "sync" && method === "POST") {
      const token = decryptToken(account.credential), errors: Record<string, string> = {};
      let quota = null, notebooks = null, notebooks_truncated = false;
      try { quota = normalizeQuota(await kaggleCall(token, "GetAcceleratorQuotaStatistics", {})); } catch (e) { errors.quota = message(e).message; }
      try { const out = await kaggleCall(token, "ListKernels", { group: "PROFILE", pageSize: 100, language: "all", kernelType: "all", outputType: "all", sortBy: "HOTNESS" }); notebooks = Array.isArray(out.kernels) ? out.kernels : []; notebooks_truncated = Boolean(out.nextPageToken); } catch (e) { errors.notebooks = message(e).message; }
      return json({ synced_at: new Date().toISOString(), quota, notebooks, notebooks_truncated, errors });
    }
    if (path[2] === "notebook-logs" && method === "GET") { const ref = validateRef(req), [userName, kernelSlug, versionLabel] = ref.split("/"); const result = await kaggleCall(decryptToken(account.credential), "ListKernelSessionOutput", { userName, kernelSlug, ...(versionLabel ? { versionLabel } : {}) }); const bytes = Buffer.from(typeof result.log === "string" ? result.log : "", "utf8"), limit = 256 * 1024; return json({ ref, content: bytes.subarray(-limit).toString("utf8").trim(), truncated: bytes.length > limit, fetched_at: new Date().toISOString() }); }
    if (path[2] === "notebook-logs-stream" && method === "GET") return await streamLogs(req, decryptToken(account.credential), validateRef(req));
    throw new AppError(404, "Không tìm thấy API.");
  } catch (error) { const e = message(error); return json({ detail: e.message }, e.status); }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;

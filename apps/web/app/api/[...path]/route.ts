import { StringDecoder } from "node:string_decoder";
import { accountById, AppError, db, decryptToken, encryptToken, initialize, parseResults, runKaggle, startKaggle } from "../../../lib/server";

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
  const { child, cleanup } = await startKaggle(token, ["kernels", "logs", ref, "--follow"]);
  const encoder = new TextEncoder(), decoder = new StringDecoder("utf8");
  let ended = false, timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (kind: string, value: object) => { if (!ended) { try { controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`)); } catch { stop(); } } };
      const stop = () => { if (ended) return; ended = true; clearTimeout(timer); child.kill(); void cleanup(); try { controller.close(); } catch {} };
      timer = setTimeout(() => { send("error", { message: "Đã hết thời gian theo dõi. Bạn có thể kết nối lại." }); stop(); }, 30 * 60 * 1000);
      req.signal.addEventListener("abort", stop, { once: true });
      if (req.signal.aborted) { stop(); return; }
      send("status", { message: "Đang kết nối Kaggle..." });
      child.stdout.on("data", (chunk: Buffer) => { const text = decoder.write(chunk); if (text) send("log", { text }); });
      child.stderr.resume();
      child.on("error", () => { send("error", { message: "Không thể chạy Kaggle CLI." }); stop(); });
      child.on("close", code => { const remaining = decoder.end(); if (remaining) send("log", { text: remaining }); send(code === 0 ? "done" : "error", { message: code === 0 ? "Phiên theo dõi đã kết thúc." : "Kaggle không mở được logs trực tiếp cho notebook này. Hãy thử bản chụp bằng nút Làm mới hoặc kiểm tra quyền truy cập." }); stop(); });
    },
    cancel() { if (!ended) { ended = true; clearTimeout(timer); child.kill(); void cleanup(); } },
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
      let success = false; try { await runKaggle(decryptToken(account.credential), ["quota"]); success = true; } finally { await db.query("UPDATE compute_accounts SET verified=$1,last_verified_at=NOW() WHERE id=$2", [success, account.id]); }
      return json((await db.query(`SELECT ${fields} FROM compute_accounts WHERE id=$1`, [account.id])).rows[0]);
    }
    if (path[2] === "sync" && method === "POST") {
      const token = decryptToken(account.credential), errors: Record<string, string> = {};
      let quota = null, notebooks = null, notebooks_truncated = false;
      try { quota = parseResults((await runKaggle(token, ["quota", "--format", "json"])).text).data; } catch (e) { errors.quota = message(e).message; }
      try { const out = parseResults((await runKaggle(token, ["kernels", "list", "--mine", "--page-size", "200", "--format", "json"])).text); notebooks = out.data; notebooks_truncated = out.truncated; } catch (e) { errors.notebooks = message(e).message; }
      return json({ synced_at: new Date().toISOString(), quota, notebooks, notebooks_truncated, errors });
    }
    if (path[2] === "notebook-logs" && method === "GET") { const ref = validateRef(req), result = await runKaggle(decryptToken(account.credential), ["kernels", "logs", ref], 256 * 1024); return json({ ref, content: result.text, truncated: result.truncated, fetched_at: new Date().toISOString() }); }
    if (path[2] === "notebook-logs-stream" && method === "GET") return streamLogs(req, decryptToken(account.credential), validateRef(req));
    throw new AppError(404, "Không tìm thấy API.");
  } catch (error) { const e = message(error); return json({ detail: e.message }, e.status); }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;

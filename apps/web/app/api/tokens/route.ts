import { AppError, db } from "../../../lib/server";
import { fail, hashToken, json, newToken, owner } from "../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Personal tokens let an MCP client (e.g. Claude) act as the signed-in user, in the workspace that was active when the token
// was created (lib/workspace.ts tokenWorkspace). Only a hash is stored. The 10-token limit is per user, across workspaces.
export async function GET(req: Request) {
  try { const s = await owner(req); return json((await db.query("SELECT t.id, t.name, t.created_at, t.last_used_at, t.workspace_id, o.name AS workspace_name, COALESCE(t.workspace_id=$2, false) AS current FROM api_tokens t LEFT JOIN organization o ON o.id=t.workspace_id WHERE t.owner_id=$1 ORDER BY t.id DESC", [s.userId, s.workspaceId])).rows); } catch (e) { return fail(e); }
}
export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = await req.json().catch(() => null), name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
    if (!name) throw new AppError(422, "Tên token là bắt buộc.");
    if (Number((await db.query("SELECT COUNT(*) FROM api_tokens WHERE owner_id=$1", [s.userId])).rows[0].count) >= 10) throw new AppError(422, "Tối đa 10 token. Hãy xóa token không dùng.");
    const token = newToken();
    const row = (await db.query("INSERT INTO api_tokens (owner_id, workspace_id, name, token_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, created_at, workspace_id", [s.userId, s.workspaceId, name, hashToken(token)])).rows[0];
    return json({ ...row, workspace_name: s.workspaceName, current: true, token }, 201); // the plaintext token is shown exactly once
  } catch (e) { return fail(e); }
}
export async function DELETE(req: Request) {
  try {
    const s = await owner(req), id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(422, "Token không hợp lệ.");
    if (!(await db.query("DELETE FROM api_tokens WHERE id=$1 AND owner_id=$2", [id, s.userId])).rowCount) throw new AppError(404, "Không tìm thấy token.");
    return new Response(null, { status: 204 });
  } catch (e) { return fail(e); }
}

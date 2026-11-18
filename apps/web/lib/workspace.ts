import "server-only";
import { randomUUID } from "node:crypto";
import { auth } from "./auth";
import { AppError, db } from "./server";

/** Who is acting and in which workspace. Papers, notes, runs and connections are shared per workspace; owner_id records the creator. */
export type Scope = { userId: string; workspaceId: string; workspaceName: string; role: string; admin: boolean };
export type Workspace = { id: string; name: string; role: string };
const toScope = (userId: string, w: Workspace): Scope => ({ userId, workspaceId: w.id, workspaceName: w.name, role: w.role, admin: w.role === "owner" || w.role === "admin" });
/** Creator of a row, or an owner/admin of the workspace, may delete or merge it. */
export const canManage = (s: Scope, creatorId: unknown) => s.admin || creatorId === s.userId;

const membership = (userId: string, preferId: string) => db.query('SELECT m."organizationId" AS id, o.name, m.role FROM member m JOIN organization o ON o.id=m."organizationId" WHERE m."userId"=$1 ORDER BY (m."organizationId"=$2) DESC, m."createdAt" LIMIT 1', [userId, preferId]).then(r => r.rows[0] as Workspace | undefined);

/**
 * Resolves the workspace for a browser session: the active one while the user is still a member, else their oldest,
 * else a new personal "Cá nhân" workspace. Keeps the session's active workspace in sync.
 */
export async function sessionWorkspace(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new AppError(401, "Vui lòng đăng nhập để tiếp tục.");
  const userId = session.user.id, activeId = session.session.activeOrganizationId ?? "";
  let workspace = await membership(userId, activeId);
  // shortcut: parallel first requests from a user with no workspace can each create one; harmless (they can leave the extra), add a per-user lock if it shows up.
  if (!workspace) workspace = { id: (await auth.api.createOrganization({ body: { name: "Cá nhân", slug: `ca-nhan-${randomUUID()}` }, headers: req.headers })).id, name: "Cá nhân", role: "owner" };
  else if (workspace.id !== activeId) await db.query('UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2', [workspace.id, session.session.id]);
  const scope = toScope(userId, workspace);
  await adoptLegacyRows(userId);
  return scope;
}

/** Workspace for a personal API token: the one it was created in, as long as the user is still a member there. */
export async function tokenWorkspace(userId: string, tokenWorkspaceId: string | null) {
  await adoptLegacyRows(userId);
  if (!tokenWorkspaceId) {
    const w = await membership(userId, "");
    if (!w) throw new AppError(403, "Tài khoản chưa thuộc workspace nào. Hãy đăng nhập web một lần rồi tạo token mới.");
    return toScope(userId, w);
  }
  const w = (await db.query('SELECT m."organizationId" AS id, o.name, m.role FROM member m JOIN organization o ON o.id=m."organizationId" WHERE m."userId"=$1 AND m."organizationId"=$2', [userId, tokenWorkspaceId])).rows[0] as Workspace | undefined;
  if (!w) throw new AppError(403, "Bạn không còn là thành viên của workspace gắn với token này.");
  return toScope(userId, w);
}

const adopted = new Set<string>();
/**
 * Rows created before workspaces existed (workspace_id NULL) move into the creator's oldest workspace, normally their
 * personal one, so private data never appears in a team workspace by itself. Papers whose DOI/arXiv/OpenAlex id already
 * exists in that workspace stay unassigned rather than breaking the unique indexes. Runs once per user per process.
 */
async function adoptLegacyRows(userId: string) {
  if (adopted.has(userId)) return;
  const home = (await db.query('SELECT "organizationId" AS id FROM member WHERE "userId"=$1 ORDER BY "createdAt" LIMIT 1', [userId])).rows[0]?.id as string | undefined;
  if (!home) return;
  const has = async (table: string, col = "workspace_id") => (await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2", [table, col])).rowCount;
  // Tables are created lazily; only remember this user once every table already has its workspace column.
  let complete = true;
  if (!(await has("papers")) || !(await has("experiment_runs")) || !(await has("api_tokens"))) complete = false;
  if (await has("papers")) await db.query(`UPDATE papers p SET workspace_id=$2 WHERE p.owner_id=$1 AND p.workspace_id IS NULL AND NOT EXISTS (SELECT 1 FROM papers q WHERE q.workspace_id=$2 AND ((p.doi IS NOT NULL AND lower(q.doi)=lower(p.doi)) OR (p.arxiv_id IS NOT NULL AND lower(q.arxiv_id)=lower(p.arxiv_id)) OR (p.openalex_id IS NOT NULL AND q.openalex_id=p.openalex_id)))`, [userId, home]);
  // A Kaggle run belongs where its connection lives; manual runs go to the home workspace.
  if (await has("experiment_runs")) await db.query("UPDATE experiment_runs r SET workspace_id=COALESCE((SELECT a.workspace_id FROM compute_accounts a WHERE a.id=r.account_id), $2) WHERE r.owner_id=$1 AND r.workspace_id IS NULL", [userId, home]);
  if (await has("api_tokens")) await db.query("UPDATE api_tokens SET workspace_id=$2 WHERE owner_id=$1 AND workspace_id IS NULL", [userId, home]);
  if (complete) adopted.add(userId);
}

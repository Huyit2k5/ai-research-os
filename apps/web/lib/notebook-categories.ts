import "server-only";
import { AppError, db } from "./server";
import { categoryIdOf, categoryName, isDuplicate, MAX_CATEGORIES } from "./documents";
import { initExperiments } from "./experiments";
import { rateLimit } from "./papers";
import { canManage, type Scope } from "./workspace";

/** Created once per workspace; deleting them does not bring them back. */
const STARTER = ["Huấn luyện", "Đánh giá"];
const REF = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
/** A Postgres INTEGER id, else null (so a huge number is a validation error, not a 500). */
const intId = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

let ready: Promise<unknown> | undefined;
/** Workspace categories for Kaggle notebooks. Notebooks are not stored here, so a label is keyed by (connection, ref). */
export function initNotebookCategories() {
  ready ??= (async () => {
    await initExperiments();
    await db.query(`
    CREATE TABLE IF NOT EXISTS notebook_categories (id SERIAL PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, name TEXT NOT NULL, created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS notebook_categories_name_idx ON notebook_categories(workspace_id, lower(name));
    CREATE TABLE IF NOT EXISTS notebook_category_seeds (workspace_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE);
    -- Deleting a category leaves its notebooks uncategorized.
    CREATE TABLE IF NOT EXISTS notebook_labels (account_id INTEGER NOT NULL REFERENCES compute_accounts(id) ON DELETE CASCADE, ref TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES notebook_categories(id) ON DELETE CASCADE, PRIMARY KEY (account_id, ref));
    ALTER TABLE notebook_categories ENABLE ROW LEVEL SECURITY; ALTER TABLE notebook_category_seeds ENABLE ROW LEVEL SECURITY; ALTER TABLE notebook_labels ENABLE ROW LEVEL SECURITY`);
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export type NotebookCategory = { id: number; name: string; notebook_count: number; can_delete: boolean };
export type NotebookLabel = { account_id: number; ref: string; category_id: number };

const FIELDS = `c.id, c.name, c.created_by AS owner_id,
  (SELECT COUNT(*)::int FROM notebook_labels l WHERE l.category_id=c.id) AS notebook_count`;
const shape = (s: Scope, r: Record<string, unknown>) => {
  const { owner_id, ...rest } = r;
  return { ...rest, can_delete: canManage(s, owner_id) } as NotebookCategory;
};

async function oneCategory(s: Scope, id: number) {
  const r = (
    await db.query(`SELECT ${FIELDS} FROM notebook_categories c WHERE c.id=$1 AND c.workspace_id=$2`, [
      id,
      s.workspaceId,
    ])
  ).rows[0];
  if (!r) throw new AppError(404, "Không tìm thấy danh mục.");
  return shape(s, r);
}

export async function listNotebookCategories(
  s: Scope,
): Promise<{ categories: NotebookCategory[]; labels: NotebookLabel[] }> {
  await initNotebookCategories();
  await db.query(
    `WITH s AS (INSERT INTO notebook_category_seeds VALUES ($1) ON CONFLICT DO NOTHING RETURNING workspace_id)
     INSERT INTO notebook_categories (workspace_id, name) SELECT s.workspace_id, n FROM s, unnest($2::text[]) n ON CONFLICT DO NOTHING`,
    [s.workspaceId, STARTER],
  );
  const [cats, labels] = await Promise.all([
    db.query(`SELECT ${FIELDS} FROM notebook_categories c WHERE c.workspace_id=$1 ORDER BY lower(c.name)`, [
      s.workspaceId,
    ]),
    db.query(
      "SELECT l.account_id, l.ref, l.category_id FROM notebook_labels l JOIN compute_accounts a ON a.id=l.account_id WHERE a.workspace_id=$1 ORDER BY l.account_id, l.ref",
      [s.workspaceId],
    ),
  ]);
  return { categories: cats.rows.map((r) => shape(s, r)), labels: labels.rows as NotebookLabel[] };
}

export async function createNotebookCategory(s: Scope, rawName: unknown): Promise<NotebookCategory> {
  await initNotebookCategories();
  const name = categoryName(rawName);
  await rateLimit(s.userId, "notebook-category", 60, 60);
  const count = Number(
    (await db.query("SELECT COUNT(*) FROM notebook_categories WHERE workspace_id=$1", [s.workspaceId])).rows[0].count,
  );
  if (count >= MAX_CATEGORIES) throw new AppError(422, `Workspace đã có tối đa ${MAX_CATEGORIES} danh mục.`);
  try {
    const id = (
      await db.query(
        "INSERT INTO notebook_categories (workspace_id, name, created_by) VALUES ($1,$2,$3) RETURNING id",
        [s.workspaceId, name, s.userId],
      )
    ).rows[0].id as number;
    return oneCategory(s, id);
  } catch (e) {
    if (isDuplicate(e)) throw new AppError(409, "Đã có danh mục cùng tên.");
    throw e;
  }
}

/** Any member may rename. */
export async function renameNotebookCategory(s: Scope, idRaw: unknown, rawName: unknown): Promise<NotebookCategory> {
  await initNotebookCategories();
  const id = categoryIdOf(idRaw);
  await oneCategory(s, id);
  const name = categoryName(rawName);
  await rateLimit(s.userId, "notebook-category", 60, 60);
  try {
    await db.query("UPDATE notebook_categories SET name=$3 WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId, name]);
  } catch (e) {
    if (isDuplicate(e)) throw new AppError(409, "Đã có danh mục cùng tên.");
    throw e;
  }
  return oneCategory(s, id);
}

/** Creator or workspace owner/admin; starter categories have no creator, so only owner/admin delete those. */
export async function deleteNotebookCategory(s: Scope, idRaw: unknown) {
  await initNotebookCategories();
  const cat = await oneCategory(s, categoryIdOf(idRaw));
  if (!cat.can_delete) throw new AppError(403, "Chỉ người tạo danh mục hoặc owner/admin được xóa.");
  await db.query("DELETE FROM notebook_categories WHERE id=$1 AND workspace_id=$2", [cat.id, s.workspaceId]);
}

/** Any member labels a notebook of a workspace connection; category_id null removes the label. */
export async function setNotebookCategory(
  s: Scope,
  accountRaw: unknown,
  refRaw: unknown,
  categoryRaw: unknown,
): Promise<{ account_id: number; ref: string; category_id: number | null }> {
  await initNotebookCategories();
  const ref = typeof refRaw === "string" ? refRaw.trim() : "";
  if (ref.length > 200 || !REF.test(ref)) throw new AppError(422, "ref phải có dạng owner/notebook.");
  const accountId = intId(accountRaw);
  const account = accountId
    ? (await db.query("SELECT id FROM compute_accounts WHERE id=$1 AND workspace_id=$2", [accountId, s.workspaceId]))
        .rows[0]
    : null;
  if (!accountId || !account) throw new AppError(404, "Không tìm thấy kết nối.");
  await rateLimit(s.userId, "notebook-label", 120, 60);
  if (categoryRaw === null) {
    await db.query("DELETE FROM notebook_labels WHERE account_id=$1 AND ref=$2", [accountId, ref]);
    return { account_id: accountId, ref, category_id: null };
  }
  const categoryId = intId(categoryRaw);
  const found =
    categoryId !== null &&
    (await db.query("SELECT 1 FROM notebook_categories WHERE id=$1 AND workspace_id=$2", [categoryId, s.workspaceId]))
      .rows.length > 0;
  if (!found) throw new AppError(422, "category_id không phải danh mục notebook của workspace.");
  await db.query(
    "INSERT INTO notebook_labels (account_id, ref, category_id) VALUES ($1,$2,$3) ON CONFLICT (account_id, ref) DO UPDATE SET category_id=EXCLUDED.category_id",
    [accountId, ref, categoryId],
  );
  return { account_id: accountId, ref, category_id: categoryId };
}

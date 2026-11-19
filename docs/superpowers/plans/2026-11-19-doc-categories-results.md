# Document Categories and Result Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace-defined document categories, and a `result` document kind whose page shows a live comparison of its linked runs above Markdown notes.

**Architecture:** All server logic stays in `lib/documents.ts` (new table `doc_categories`, column `documents.category_id`, kind `result`). Categories get REST routes under `app/api/docs/categories/**` and one MCP tool. The result page reuses `CompareView` from `runs-screen.tsx` (exported) fed by the existing `GET /api/runs/compare` and `GET /api/runs/:id` routes.

**Tech Stack:** Next.js 16 / React 19, `pg`, existing documents/runs code. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-doc-categories-results-design.md`

## Global Constraints

- UI and error strings in Vietnamese; Prettier (`npm run format`), one statement per line.
- Categories: name 1–60 characters after trim, unique per workspace ignoring case, at most 50 per workspace; a document has at most one category; deleting a category sets its documents' `category_id` to NULL.
- Create/rename a category: any member. Delete: creator or owner/admin (`canManage`).
- Kind `result`: text only (`markdown`), no `status`, at most 10 linked runs, never an upload.
- New table has RLS enabled. Tests never touch the real Supabase.

## Review Focus

1. A category id from another workspace in `category_id` or `?category=` → 422 / empty list, never a cross-workspace link (Task 1 test `foreign category`).
2. Renaming to an existing name in different case ("lora" vs "LoRA") → 409 (Task 1 test `duplicate name`).
3. Changing a doc with 11 linked runs to `kind: "result"` → 422, nothing changed (Task 1 test `result over 10 runs via kind change`).
4. A result page whose runs were deleted down to 1 or 0 → page still renders (single-run summary / prompt to link runs) (Task 3 Playwright step).
5. Uploading a file with `kind: "result"` → 422 (Task 1 test `result upload`).

---

### Task 1: Categories and the result kind in the server

**Files:**
- Modify: `apps/web/lib/documents.ts`
- Create: `apps/web/app/api/docs/categories/route.ts` (GET list, POST create; `owner(req, { allowToken: true })`)
- Create: `apps/web/app/api/docs/categories/[id]/route.ts` (PATCH rename, DELETE)
- Modify: `apps/web/app/api/docs/route.ts` (GET passes `category`)
- Test: `apps/web/tests/doc-categories.mjs` (harness copied from `tests/run-requests-isolation.mjs`; env `DOCCAT_TEST_BASE`; no MinIO needed except the upload check, which only needs the 422 before any storage call — if storage is not configured the route answers 503 first, so assert `[422, 503]` and note it)

**Interfaces:**
- Produces:
  - `DOC_KINDS = ["idea", "result", "report", "other"]`
  - `type Category = { id: number; name: string; doc_count: number; created_by: string | null; can_delete: boolean }`
  - `listCategories(s: Scope): Promise<Category[]>` (ordered by name)
  - `createCategory(s: Scope, name: unknown): Promise<Category>` (422 bad name, 409 duplicate, 422 over 50)
  - `renameCategory(s: Scope, id: unknown, name: unknown): Promise<Category>`
  - `deleteCategory(s: Scope, id: unknown): Promise<void>` (403 unless `canManage`)
  - `DocRow` gains `category_id: number | null` and `category_name: string | null`
  - `ListDocsOpts.category?: number | "none"`; `createTextDoc` / `startUpload` / `updateDoc` accept `category_id` (null clears)

- [ ] **Step 1: Write failing tests** in `tests/doc-categories.mjs`: anonymous `GET /api/docs/categories` → 401; A creates "LoRA" → 201 with `doc_count: 0`; `duplicate name` "lora" → 409; empty / 61-char name → 422; B (other workspace) does not see it and PATCH/DELETE → 404; A creates a markdown doc with `category_id` → 201 and `category_name: "LoRA"`; list `?category=<id>` returns it, `?category=none` does not; `foreign category`: A creates with B's category id → 422; rename to "LoRA 2" → doc shows the new name; C (member of A's workspace, invited as in run-requests test) can create/rename but DELETE A's category → 403; A deletes → 204 and the doc still exists with `category_id: null`; the 51st category → 422 mentioning 50. Result kind: create `kind: "result"` with 2 of A's runs (create manual runs via `POST /api/runs`) → 201; with 11 runs → 422; with `status: "new"` → 422; `result over 10 runs via kind change`: a `report` with 11 runs PATCHed to `kind: "result"` → 422 and the doc is still `report`; `result upload`: `POST /api/docs/uploads` with `kind: "result"` → 422 (or 503 when storage is unset); MCP `list_doc_categories` lists "LoRA 2"-style names for the token's workspace only.
- [ ] **Step 2: Run against a disposable server on the current build** → fails (404 routes).
- [ ] **Step 3: Implement.** In `initDocs()` add the `doc_categories` table (unique index on `(workspace_id, lower(name))`, RLS), `ALTER TABLE documents ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL`, and replace the kind check (`DROP CONSTRAINT IF EXISTS documents_kind_check` then ADD with the four kinds). `FIELDS` adds `d.category_id, c.name AS category_name` via `LEFT JOIN doc_categories c ON c.id=d.category_id`. The 10-run limit is checked inside the same transaction after `setLinks`: if the final kind is `result` and `SELECT COUNT(*) FROM document_runs WHERE document_id=$1` > 10 → 422 (rolls back). `baseFields` rejects `status` for `result` like other non-idea kinds; `startUpload` rejects `kind: "result"` before the storage check. Unique violations (`23505`) on create/rename map to 409.
- [ ] **Step 4: Rebuild, run** `DOCCAT_TEST_BASE=http://localhost:3004 node tests/doc-categories.mjs` → all pass; `node tests/save-kernel.test.mjs` still passes.
- [ ] **Step 5: Commit** `Add document categories and the result kind`.

### Task 2: MCP

**Files:** Modify `apps/web/app/api/mcp/route.ts`; Test: `apps/web/tests/doc-categories.mjs` (extend)

**Interfaces:** Consumes Task 1 functions. Produces tool `list_doc_categories` (read-only); `list_docs` gains `category` (integer or `"none"`); `create_doc` / `update_doc` gain `category_id` (integer or null); the `create_doc` description says a `result` doc with `run_ids` (2–10) shows a live comparison table and charts, so the AI only writes the conclusion.

- [ ] **Step 1: Failing tests:** `tools/list` has `list_doc_categories`; `create_doc` via MCP with `kind: "result"`, `run_ids`, `category_id` → doc has both; `list_docs` with `category` filters.
- [ ] **Step 2–4:** run (fail), implement, run (pass).
- [ ] **Step 5: Commit** `Add document categories and result docs to MCP`.

### Task 3: UI

**Files:**
- Modify: `apps/web/app/runs-screen.tsx` — `export function CompareView` with `back` optional; in the compare view add **Lưu thành kết quả** (prompt for a title, default `So sánh run #a, #b…`; `POST /api/docs` `{ kind: "result", format: "markdown", title, body: "", run_ids }`; open `/docs/:id` in a new tab).
- Create: `apps/web/app/result-view.tsx` — `export default function ResultView({ runIds }: { runIds: number[] })`: 0 runs → note "Chưa gắn run nào"; 1 run → metrics of that run (from `GET /api/runs/:id`); 2–10 → `GET /api/runs/compare?ids=` + each run's history, rendered with `CompareView` (no back button).
- Modify: `apps/web/app/docs/[id]/page.tsx` — `result` docs render `ResultView` above the notes; side panel gets a category select (`PATCH category_id`); idea docs get **Tạo kết quả từ các run** (latest ≤10 linked runs, body starts with `Ý tưởng: [title](/docs/<id>)`, opens the new doc).
- Modify: `apps/web/app/docs-screen.tsx` — `KINDS` adds `result: "Kết quả"`; left category column (Tất cả, Chưa phân loại, each with count, + Thêm, rename/delete); list filter `category`; Write modal category select; Upload modal kind select excludes `result` and has the category select.
- Modify: `apps/web/app/docs.css` (`dc-cat*` classes).

- [ ] **Step 1:** `npm run build` and `npm run format:check` pass.
- [ ] **Step 2: Browser check** on the disposable server (Playwright when connected, else the user's browser): create a category and a doc in it, filter; save a comparison as a result and open it (table + chart visible); delete one of its two runs and reload (single-run summary renders).
- [ ] **Step 3: Commit** `Add category column, result pages and create-result buttons`.

### Task 4: Docs

- [ ] Update `CLAUDE.md` (Documents bullet: categories, `result`, 33 MCP tools, `tests/doc-categories.mjs`) and README (Tài liệu section). Commit `Document categories and result pages`, push, open the PR.

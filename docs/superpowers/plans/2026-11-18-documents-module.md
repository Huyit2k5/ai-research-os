# Module Tài liệu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workspace-shared documents module (ideas, reports, other). Documents are written by AI over MCP/REST or uploaded by people (HTML, PDF, Word, images), linked to papers and runs, and stored in Cloudflare R2 (S3 API) in a way that works on Vercel.

**Architecture:**
- Document rows live in Supabase Postgres (`documents`, `document_papers`, `document_runs`), created lazily in `lib/documents.ts` with RLS.
- File bytes never pass through the app. The browser PUTs to a presigned URL, and viewing redirects to a presigned GET. Both URLs come from `lib/storage.ts`, which speaks the S3 protocol via `aws4fetch`, so R2, AWS S3 and MinIO (tests) are interchangeable by env vars.
- REST under `app/api/docs/**`, MCP tools in `app/api/mcp/route.ts`, a list screen in the SPA, and a full-page viewer at `/docs/[id]`.

**Tech Stack:** Next.js 16 / React 19, `pg`, Better Auth workspaces (existing), `aws4fetch` (new), `mammoth` (new, browser-only, dynamic import), MinIO for tests.

**Spec:** `docs/superpowers/specs/2026-11-18-documents-module-design.md`

## Global Constraints

- All user-facing strings in Vietnamese. Match the dense code style of `lib/papers.ts` and `lib/experiments.ts`.
- Scope every query by `workspace_id` from `owner(req, { allowToken: true })` (`lib/papers.ts`). Deleting needs `canManage(s, owner_id)` (`lib/workspace.ts`).
- Every new table gets `ENABLE ROW LEVEL SECURITY` in its lazy init.
- Limits:
  - 25 MB per file.
  - Text `body` ≤ 512 KB.
  - Title ≤ 300 characters.
  - ≤ 20 tags.
  - 5000 documents per workspace.
  - Total stored file bytes across the whole project ≤ `STORAGE_LIMIT_MB` (default 9000, under R2's 10 GB free tier).
  - Uploads: 30 per minute per user (`rateLimit`).
- `kind` ∈ `idea | report | other`. `status` (ideas only) ∈ `new | trying | chosen | dropped`. `format` ∈ `markdown | html | file`. `upload_state` ∈ `pending | ready`.
- Object keys are `ws/<workspace_id>/<uuid>`; never the user's filename. The bucket is private.
- Presigned PUT expires in 10 minutes and signs `Content-Type` and `Content-Length`. Presigned GET expires in 5 minutes.
- Only `application/pdf`, `image/png|jpeg|gif|webp` and `text/html` are served `inline`. Everything else, including SVG and .docx, is `attachment`.
- HTML is rendered only in `<iframe sandbox="">`, with no `allow-scripts` and no `allow-same-origin`. PDFs go in a plain iframe.
- Env vars: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `STORAGE_LIMIT_MB`. If any S3 var is missing, uploads fail with a Vietnamese error while text docs keep working.
- Tests run only against a disposable Postgres and MinIO, never the shared Supabase or the real R2 bucket.

## Review Focus

1. **Unicode or quoted filenames** (`Báo cáo tuần 46 "final".pdf`): the download must keep the name. Use `Content-Disposition` with RFC 5987 `filename*=UTF-8''…` and an ASCII fallback. Test in Task 3.
2. **Declared type or size differs from what was PUT** (or nothing was PUT): `complete` must reject, delete the object and the pending row, and the doc must never become viewable. Test in Task 3.
3. **Abandoned uploads**: pending rows are invisible in lists, are counted once toward the quota, and are swept after 1 hour on the next `startUpload`. Test in Task 3.
4. **`status` sent for a non-idea, or kind changed away from `idea`**: 422 for the first. For the second, `status` is cleared. Test in Task 2.
5. **Links to papers or runs from another workspace or that don't exist**, and **a removed member's token**: 422 and 403 respectively, nothing written. Test in Task 2.

---

### Task 0: R2 setup (human, with the user)

**Files:** none (Cloudflare dashboard).

- [ ] **Step 1: Create the bucket and key.** In the Cloudflare dashboard → R2 (adding a payment method is required to enable R2, even on the free tier):
  - Create the bucket `research-docs`.
  - Create an **R2 API token** with **Object Read & Write**, **scoped to that bucket only**. Copy the Access Key ID, the Secret Access Key and the S3 endpoint `https://<account_id>.r2.cloudflarestorage.com`.
- [ ] **Step 2: Add the bucket CORS policy.** Bucket → Settings → CORS policy: `AllowedOrigins` = `http://localhost:3001` and the Vercel production + preview URLs; `AllowedMethods` = `GET`, `PUT`; `AllowedHeaders` = `content-type`, `content-length`; `ExposeHeaders` = `content-type`, `content-disposition`, `content-length`; `MaxAgeSeconds` = 3600.
- [ ] **Step 3: Fill the env vars.** `S3_ENDPOINT`, `S3_REGION=auto`, `S3_BUCKET=research-docs`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` go into the root `.env`, `apps/web/.env.local` and the Vercel project env (Production + Preview).

### Task 1: Storage capability check

**Files:**
- Create: `apps/web/scripts/storage-check.mjs`
- Modify: `apps/web/package.json` (add `aws4fetch`)

**Interfaces:**
- Produces: `node --env-file=.env.local scripts/storage-check.mjs [--origin http://localhost:3001]` prints one ✓/✗ line per capability and exits non-zero on any ✗.

- [ ] **Step 1: Write the script.** Using `AwsClient` from `aws4fetch` with path-style URLs, check each of these:
  1. A presigned PUT with signed `Content-Type`/`Content-Length` uploads 1 KB.
  2. A PUT with a different `Content-Length` is rejected.
  3. HEAD returns the size and type.
  4. A presigned GET with `response-content-disposition=attachment; filename*=UTF-8''B%C3%A1o.pdf` and `response-content-type` returns those headers.
  5. A CORS preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method: PUT`) is allowed for `--origin`.
  6. DELETE works.
- [ ] **Step 2: Run it against MinIO.** Command: `docker run -d --name ros-minio -p 127.0.0.1:59000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio-secret-123 minio/minio server /data`. Create the bucket with a signed `PUT /<bucket>`. Expected: all 6 ✓.
- [ ] **Step 3: Run it against R2**, with the Task 0 env, for `--origin http://localhost:3001` and for the Vercel URL. Expected: all ✓. If check 5 (CORS) fails, the Task 0 CORS policy is missing that origin; fix it in the dashboard, not in code.
- [ ] **Step 4: Commit:** `git add apps/web/scripts/storage-check.mjs apps/web/package.json apps/web/package-lock.json && git commit -m "Add S3 storage capability check"`

### Task 2: Text documents, links and REST

**Files:**
- Create: `apps/web/lib/documents.ts`
- Create: `apps/web/app/api/docs/route.ts` (GET, POST)
- Create: `apps/web/app/api/docs/[id]/route.ts` (GET, PATCH, DELETE)
- Modify: `apps/web/lib/papers.ts` (inside `mergePapers`, next to the `experiment_runs` re-point near line 531)
- Test: `apps/web/tests/docs-isolation.mjs` (copy the `request`/`signUp`/`mcp`/`tool` helpers from `tests/runs-isolation.mjs`; base URL from `DOCS_TEST_BASE`)

**Interfaces:**
- Consumes: `owner`, `json`, `fail`, `rateLimit` from `lib/papers.ts`; `canManage`, `Scope` from `lib/workspace.ts`; `db`, `AppError` from `lib/server.ts`.
- Produces (in `lib/documents.ts`):
  - `initDocs(): Promise<unknown>`
  - `type DocRow = { id: number; kind: string; title: string; status: string | null; format: string; tags: string[]; file_name: string | null; file_type: string | null; file_size: number | null; created_via: "web" | "api"; created_by: string | null; can_delete: boolean; paper_count: number; run_count: number; created_at: string; updated_at: string }`
  - `listDocs(s: Scope, o: { q?: string; kind?: string; status?: string; tag?: string; limit?: number; offset?: number }): Promise<{ total: number; offset: number; limit: number; items: DocRow[] }>`: excludes `upload_state='pending'`; ordered by `updated_at DESC`.
  - `getDoc(s: Scope, id: unknown): Promise<DocRow & { body: string | null; papers: { id: number; title: string }[]; runs: { id: number; name: string }[] }>`
  - `createTextDoc(s: Scope, via: "web" | "api", f: Record<string, unknown>): Promise<DocRow>`
  - `updateDoc(s: Scope, id: unknown, f: Record<string, unknown>): Promise<DocRow>`: `paper_ids`/`run_ids` replace the whole link set.
  - `deleteDoc(s: Scope, id: unknown): Promise<{ file_key: string | null }>`: the caller deletes the object.
  - Constants `DOC_KINDS`, `IDEA_STATUSES`, `MAX_DOCS = 5000`, `MAX_BODY = 512 * 1024`.

- [ ] **Step 1: Write failing tests** in `docs-isolation.mjs`. Each line is one assertion with its own `ok(...)`:
  - Anonymous `GET /api/docs` → 401.
  - User A `POST /api/docs {kind:"idea", title:"Thêm S_obj", format:"markdown", body:"# x"}` → 201, `status === "new"`, `created_via === "web"`.
  - B (other workspace) `GET`/`PATCH`/`DELETE /api/docs/:id` → 404 each.
  - A `PATCH {status:"chosen"}` → 200. `POST {kind:"report", status:"new", …}` → 422. `PATCH {kind:"report"}` on the idea → 200 and `status === null`.
  - `body` of 512 KB + 1 byte → 422. A title of 301 characters → 422. 21 tags → 422.
  - Links:
    - `paper_ids:[B's paper]` → 422.
    - `run_ids:[999999]` → 422.
    - A's own paper and run → 200, and `getDoc` shows both.
    - Deleting that run → `run_count === 0`.
    - Merging A's two papers keeps the link on the kept paper.
  - The same create via Bearer token → `created_via === "api"`. After A removes B from a shared workspace, B's token gets 403 on `GET /api/docs`.
  - A member who is not the creator gets `DELETE` → 403. The creator gets 204.
  - `GET /api/docs?kind=idea&status=chosen&q=S_obj` returns only the matching doc.
- [ ] **Step 2: Run and see it fail.** Command: `DOCS_TEST_BASE=http://localhost:3002 node tests/docs-isolation.mjs`, against a dev server on a disposable DB per CLAUDE.md. Expected: the first doc assertion fails with 404.
- [ ] **Step 3: Implement `lib/documents.ts` and both route files.**
  - Tables per spec §5.1, plus indexes on `(workspace_id, updated_at)`.
  - `document_papers`/`document_runs` use composite PKs, with `ON DELETE CASCADE` on both FKs.
  - `q` matches `title ILIKE` or `body ILIKE`.
  - Routes call `owner(req, { allowToken: true })`.
  - In `mergePapers`, re-point `document_papers` to the kept id with `ON CONFLICT DO NOTHING` semantics (insert-select, then delete), only if the table exists.
- [ ] **Step 4: Run and see it pass.** Expected: all Task 2 checks ✓. `runs-isolation.mjs` and `papers-isolation.mjs` still pass (run them ≥65 s apart because of the sign-up rate limit).
- [ ] **Step 5: Commit:** `git commit -m "Add workspace documents: text docs, idea status, paper/run links"`

### Task 3: File uploads through presigned URLs

**Files:**
- Create: `apps/web/lib/storage.ts`
- Create: `apps/web/app/api/docs/uploads/route.ts` (POST)
- Create: `apps/web/app/api/docs/[id]/complete/route.ts` (POST)
- Create: `apps/web/app/api/docs/[id]/file/route.ts` (GET)
- Modify: `apps/web/lib/documents.ts`
- Test: `apps/web/tests/docs-isolation.mjs` (the test server runs with MinIO env)

**Interfaces:**
- Produces (`lib/storage.ts`):
  - `storageConfigured(): boolean`
  - `presignPut(key: string, contentType: string, size: number): Promise<{ url: string; headers: Record<string, string> }>`
  - `presignGet(key: string, o: { fileName: string; contentType: string; inline: boolean }): Promise<string>`
  - `headObject(key: string): Promise<{ size: number; contentType: string } | null>`
  - `deleteObject(key: string): Promise<void>`
- Produces (`lib/documents.ts`):
  - `startUpload(s: Scope, via: "web" | "api", f: Record<string, unknown>): Promise<{ id: number; upload_url: string; headers: Record<string, string> }>`
  - `completeUpload(s: Scope, id: unknown): Promise<DocRow>`
  - `fileUrl(s: Scope, id: unknown, download: boolean): Promise<string>`
  - `MAX_FILE = 25 * 1024 * 1024`
  - `INLINE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/html"]`
- `DELETE /api/docs/:id` now also calls `deleteObject` (errors logged, not thrown).

- [ ] **Step 1: Write failing tests.** Each step PUTs with `fetch(upload_url, { method: "PUT", headers, body })`.
  - A uploads `Báo cáo tuần 46 "final".pdf` (1 KB, `application/pdf`): uploads → 200, PUT → 200, complete → 200, `format === "file"`.
  - `GET /file` → 302 to MinIO. Following it returns the bytes, `Content-Type: application/pdf`, `Content-Disposition` starting `inline` and containing `filename*=UTF-8''B%C3%A1o`.
  - `GET /file?download=1` → `attachment`.
  - Each type gets the right disposition:
    - An `image/svg+xml` upload → `attachment`.
    - A `.docx` (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) → `attachment`.
    - `text/html` → `inline`.
  - B `GET /api/docs/:id/file` → 404.
  - Declared size 1024 but PUT 2048 bytes: the PUT is rejected, or `complete` → 422 and the doc is gone. Declared type `application/pdf` but the object's type is `text/html` → `complete` 422.
  - `complete` with nothing uploaded → 422 and the row is deleted.
  - A pending doc is absent from `GET /api/docs`.
  - `size: 25*1024*1024 + 1` → 413.
  - With the test server started at `STORAGE_LIMIT_MB=1`: a 600 KB upload, then a second 600 KB `uploads` request → 413.
  - `DELETE` of the uploaded doc → 204, and `headObject` (via a second `GET /file` → 404) shows it gone.
- [ ] **Step 2: Run and see it fail.** Command: as in Task 2, with the server env `S3_ENDPOINT=http://127.0.0.1:59000 S3_REGION=us-east-1 S3_BUCKET=research-docs S3_ACCESS_KEY_ID=minio S3_SECRET_ACCESS_KEY=minio-secret-123`. Expected: `uploads` → 404.
- [ ] **Step 3: Implement.**
  - `startUpload`:
    - Validates kind, tags and links the same way as text docs.
    - `size` must satisfy `1 ≤ size ≤ MAX_FILE`. A missing or invalid `content_type` becomes `application/octet-stream`.
    - Sweeps pending rows older than 1 hour (deleting their objects).
    - Checks `SUM(file_size)` over all `documents` plus `size` against `STORAGE_LIMIT_MB`.
    - Inserts the row with `upload_state='pending'` and presigns.
  - `completeUpload` compares `headObject` with the row. On a mismatch it deletes both and throws `AppError(422, …)`.
  - `fileUrl` requires `upload_state='ready'`. `inline` is `!download && INLINE_TYPES.includes(file_type)`.
- [ ] **Step 4: Run and see it pass.** Expected: all Task 2 and Task 3 checks ✓.
- [ ] **Step 5: Commit:** `git commit -m "Add document file uploads via presigned S3 URLs"`

### Task 4: MCP tools

**Files:**
- Modify: `apps/web/app/api/mcp/route.ts` (`TOOLS` array and `callTool` switch)
- Test: `apps/web/tests/docs-isolation.mjs`

**Interfaces:**
- Consumes: the Task 2 functions, with `via = "api"`.
- Produces the tools:
  - `list_docs` (`readOnlyHint`; args `query`, `kind`, `status`, `tag`, `limit`, `offset`)
  - `get_doc` (`readOnlyHint`; `id`; the description carries the existing `NOTE` untrusted-content warning; file docs return metadata, no bytes)
  - `create_doc` (`kind`, `title`, `format` ∈ `markdown|html`, `body`, `status?`, `tags?`, `paper_ids?`, `run_ids?`)
  - `update_doc` (`id` plus any of those fields)
  - `delete_doc` (`destructiveHint`; the description says to call it only after the user confirms the specific document)

- [ ] **Step 1: Write failing tests.**
  - `tools/list` contains the 5 names, and `delete_doc.annotations.destructiveHint === true`.
  - Via A's token, `create_doc {kind:"report", title:"Báo cáo tuần", format:"html", body:"<h1>x</h1><script>alert(1)</script>"}` → `created_via === "api"`, and `get_doc` returns the body unchanged.
  - `update_doc {id, run_ids:[A's run]}` → `run_count === 1`.
  - B's token on `get_doc` for A's doc → `isError`.
  - `delete_doc` → deleted.
- [ ] **Step 2: Run and see it fail.** Expected: `tools/list` lacks `create_doc`.
- [ ] **Step 3: Implement**, following the existing `get_run`/`delete_run` cases.
- [ ] **Step 4: Run and see it pass.** Expected: all checks ✓.
- [ ] **Step 5: Commit:** `git commit -m "Add MCP tools for documents"`

### Task 5: UI — list screen, editor, viewer page

**Files:**
- Create: `apps/web/app/docs-screen.tsx` and `apps/web/app/docs.css` (scoped `dc-*` classes; import in `app/layout.tsx` like `runs.css`)
- Create: `apps/web/app/docs/[id]/page.tsx`
- Modify: `apps/web/app/page.tsx` (add `"docs"` to the screen union, a nav item `{id:"docs",label:"Tài liệu",icon:FileText}` after runs, the title map and the render branch)
- Modify: `apps/web/app/notebook-view.tsx` (export `Markdown`)
- Modify: `apps/web/package.json` (add `mammoth`)

**Interfaces:**
- Consumes: the REST routes from Tasks 2–3; `Markdown` from `notebook-view.tsx`.

- [ ] **Step 1: Build the list screen.**
  - Filters: kind tabs, status (shown when kind = idea), tag, search.
  - Rows show: title, kind, idea status, linked paper/run counts, creator plus "qua MCP/API" when `created_via === "api"`, `updated_at`.
  - Clicking a row opens `/docs/<id>` in a new tab.
- [ ] **Step 2: Add "Viết mới".** A modal with title, kind, Markdown textarea, preview via `Markdown`, and tags, posting to `POST /api/docs`.
- [ ] **Step 3: Add "Upload".**
  - Pick a file, then `POST /api/docs/uploads`, then `PUT` with the returned `headers`, then `POST …/complete`.
  - Errors show inline in Vietnamese, including the CORS failure hint "Kho file chưa cho phép tên miền này (CORS)".
- [ ] **Step 4: Build the `/docs/[id]` page.**
  - Header: title, kind, creator/source, and "Tải file gốc" (`/file?download=1`).
  - Idea status buttons send `PATCH`.
  - Linked papers and runs are listed with a remove control, plus an add picker that reuses `GET /api/papers?limit=100` and `GET /api/runs?limit=100`.
  - Tags; edit (text docs) and delete (if `can_delete`).
  - Viewer by type:
    - markdown → `Markdown`
    - html body → `<iframe sandbox="" srcDoc>`
    - html file → `<iframe sandbox="" src="/api/docs/<id>/file">`
    - pdf → `<iframe src=…/file>`
    - image → `<img>`
    - docx → `import("mammoth")`, then `convertToHtml({ arrayBuffer })` from the presigned URL (fetch `…/file` and follow the redirect), into `<iframe sandbox="" srcDoc>`
    - else → download only
- [ ] **Step 5: Verify in Playwright (Chromium)** on the test stack, with one of each: markdown idea, html report containing `<script>document.title='pwned'</script>`, pdf, png, docx.
  - Each renders.
  - The page title never becomes `pwned`.
  - An `iframe[sandbox=""]` exists for the html cases.
  - The PDF iframe shows the viewer, not a "blocked" page.
- [ ] **Step 6: Commit:** `git commit -m "Add documents screen and viewer page"`

### Task 6: Docs and env

**Files:**
- Modify: `.env.example`, `README.md` (new "Tài liệu" section, the Task 0 steps, CORS setup, the R2 switch = change the 5 env vars), `CLAUDE.md` (module summary and the `tests/docs-isolation.mjs` usage line), `docs/KAGGLE_CONNECTOR_ROADMAP.md` or the architecture roadmap checklist (tick documents).

- [ ] **Step 1: Write the docs.** Re-read each file against the shipped code.
- [ ] **Step 2: Run `npm run build` in `apps/web`.** Expected: compiles, and the routes list shows `/api/docs/**` and `/docs/[id]`.
- [ ] **Step 3: Commit:** `git commit -m "Document the documents module and storage setup"`

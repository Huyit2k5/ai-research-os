# Notebook Push with Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI proposes Kaggle notebook runs (code + machine + idea); a human approves on the web; the app pushes with `SaveKernel`, follows the run live, captures it and links it to the idea.

**Architecture:** New lazily-created table `run_requests` in `lib/run-requests.ts`. A pure body builder `lib/save-kernel.ts` turns (current Kaggle metadata, requested settings, code) into a `SaveKernel` request. REST under `app/api/run-requests/**`; approve/reject/run-now accept **sessions only** (`owner(req)` without `allowToken`). MCP gets 4 tools. UI: tabs in `runs-screen.tsx`, a review page `app/run-requests/[id]/page.tsx`, a shared `LiveLog` component extracted from `logs-screen.tsx`.

**Tech Stack:** Next.js 16 / React 19, `pg`, existing `kaggleCall`, `captureRun`, `notebook-view`. New dependency: `diff` (jsdiff) for the review diff.

**Spec:** `docs/superpowers/specs/2026-11-18-notebook-push-design.md`

## Global Constraints

- UI strings, errors and MCP descriptions in Vietnamese. Dense code style matching surrounding files.
- Approve, reject and run-now: session only, CSRF via `owner()`'s Origin check. No MCP tool and no token route may approve.
- Statuses exactly: `pending | approved | running | done | failed | rejected | cancelled | expired`.
- Limits: code ≤ 2 MB (`2 * 1024 * 1024` bytes UTF-8); summary ≤ 4000; review note ≤ 2000; 50 `pending` per workspace; create 30/hour per user (`rateLimit(userId, "run-request", 30, 3600)`); approve/run-now 10/min per user (`rateLimit(userId, "run-approve", 10, 60)`); `pending` older than 7 days → `expired`.
- Machines: `t4x2 → "NvidiaTeslaT4"`, `l4 → "NvidiaL4"`, `tpu → "TpuV5E8"`, `cpu → ""`. New notebook without `machine` → `cpu`. Existing notebook: unspecified fields inherit from `GetKernel` metadata; never send an empty source list to mean "unchanged".
- `kernelExecutionType` is always `"SaveAndRunAll"`; `language` is `"python"`; `isPrivate` defaults to `true` for new notebooks.
- Kaggle errors at approve time return the row to `pending` with `error`; `failed` only for a Kaggle session that ran and ended in error.
- New table: RLS enabled. Never run tests against the real Supabase.

## Review Focus

1. AI omits `dataset_sources` for an existing notebook → the pushed body keeps the notebook's current sources (Task 2 test `inherits sources`).
2. Two reviewers click "Duyệt" at once → exactly one push, the other gets 409 (Task 4 test `double approve`).
3. A token (the AI) calls approve / reject / run-now → 401, the row stays `pending` (Task 4 test `token cannot approve`).
4. `kernel_type: "notebook"` with code that is not valid ipynb JSON → 422 at creation, not a Kaggle error later (Task 3 test `bad ipynb`).
5. The linked idea is deleted after the request was made → request keeps working with `idea_id = null` (Task 3 test `idea deleted`).

---

### Task 1: Kaggle SaveKernel check script (real account)

**Files:**
- Create: `apps/web/scripts/kaggle-push-check.mjs`
- Modify: `docs/superpowers/specs/2026-11-18-notebook-push-design.md` §4 (record confirmed field names and response)

**Interfaces:**
- Produces: confirmed `SaveKernel` request/response field names used by Task 2 and Task 4.

- [ ] **Step 1: Write the script.** `node --env-file=.env.local scripts/kaggle-push-check.mjs <account_id>`: reads the connection from `DATABASE_URL`, decrypts the credential with the same Fernet logic as `lib/server.ts` `decryptToken` (copy the 10 lines; it never prints the token), calls `POST https://api.kaggle.com/v1/kernels.KernelsApiService/SaveKernel` with `{ newTitle: "ros push check", text: "print('ros push check ok')", language: "python", kernelType: "script", isPrivate: true, enableGpu: false, enableInternet: false, kernelExecutionType: "SaveAndRunAll" }`, prints the response JSON keys and values except anything named like `token`. Then `GetKernelSessionStatus` for the returned ref every 10 s until terminal, then `GetKernel` and prints `metadata` keys (to learn `currentVersionNumber`, source fields, `machineShape`).
- [ ] **Step 2: Run it** with a real connection (requires the local `CREDENTIAL_ENCRYPTION_KEY` to equal prod's). Expected: a `ref` like `<user>/ros-push-check`, a `versionNumber`, terminal status `complete`.
- [ ] **Step 3: Second run against the same ref** with `slug: "<ref>"` and no source lists, then `GetKernel` again: record whether omitted source lists wipe sources (attach any public dataset by hand on Kaggle before this run).
- [ ] **Step 4: Update spec §4** with the confirmed names (including whether `slug` takes `owner/slug`) and commit.

```bash
git add apps/web/scripts/kaggle-push-check.mjs docs/superpowers/specs/2026-11-18-notebook-push-design.md
git commit -m "Add a SaveKernel check script and record the confirmed fields"
```

### Task 2: Pure SaveKernel body builder

**Files:**
- Create: `apps/web/lib/save-kernel.ts` (no `server-only`, no imports, so Node can load it directly)
- Test: `apps/web/tests/save-kernel.test.mjs` (run with `node tests/save-kernel.test.mjs`; Node 22.18 strips types)

**Interfaces:**
- Produces:
  - `export type PushSettings = { machine?: "t4x2" | "l4" | "tpu" | "cpu"; enable_internet?: boolean; is_private?: boolean; dataset_sources?: string[]; competition_sources?: string[]; kernel_sources?: string[]; model_sources?: string[] }`
  - `export const MACHINES: Record<string, string>` (map in Global Constraints)
  - `export function parseSettings(raw: unknown): PushSettings` — throws `Error` with a Vietnamese message on unknown machine, non-boolean flags, >20 entries per source list, or a source not matching `^[A-Za-z0-9_.\/-]{1,200}$`
  - `export function buildSaveKernelBody(input: { ref: string | null; newTitle: string | null; kernelType: "notebook" | "script"; code: string; settings: PushSettings; current: Record<string, unknown> | null }): Record<string, unknown>` where `current` is `GetKernel().metadata` (null for a new notebook)
  - `export function validateCode(code: unknown, kernelType: "notebook" | "script"): string` — throws on empty, > 2 MB, or (notebook) not JSON with an array `cells`

- [ ] **Step 1: Write failing tests** (plain `node:assert`):
  - `machine t4x2` → `enableGpu: true, machineShape: "NvidiaTeslaT4"`; `cpu` → `enableGpu: false, machineShape: ""`.
  - `inherits sources`: `current = { datasetDataSources: ["a/b"], enableGpu: true, machineShape: "NvidiaTeslaT4", enableInternet: true }`, settings `{}` → body keeps all four.
  - explicit `dataset_sources: []` → body has `datasetDataSources: []` (explicit empty is allowed).
  - new notebook (`ref: null, current: null`, no machine) → `newTitle` set, no `slug`, `isPrivate: true`, `machineShape: ""`.
  - always `kernelExecutionType: "SaveAndRunAll"`, `language: "python"`, `text === code`.
  - `parseSettings({ machine: "a100" })` throws; `validateCode("{}", "notebook")` throws; `validateCode("x".repeat(2*1024*1024+1), "script")` throws.
- [ ] **Step 2: Run** `node tests/save-kernel.test.mjs` → fails (module missing).
- [ ] **Step 3: Implement** `lib/save-kernel.ts` with the field names confirmed in Task 1.
- [ ] **Step 4: Run** → all pass.
- [ ] **Step 5: Commit** `git commit -m "Add the SaveKernel body builder"`.

### Task 3: run_requests table, create/list/get/cancel/reject

**Files:**
- Create: `apps/web/lib/run-requests.ts`
- Create: `apps/web/app/api/run-requests/route.ts` (GET list, POST create; `owner(req, { allowToken: true })`)
- Create: `apps/web/app/api/run-requests/[id]/route.ts` (GET; `allowToken: true`)
- Create: `apps/web/app/api/run-requests/[id]/reject/route.ts` (POST; session only)
- Create: `apps/web/app/api/run-requests/[id]/cancel/route.ts` (POST; `allowToken: true`)
- Test: `apps/web/tests/run-requests-isolation.mjs` (copy the harness from `tests/runs-isolation.mjs`: `request`, `mcp`, `tool`, `signUp`; base env `RUNREQ_TEST_BASE`)

**Interfaces:**
- Consumes: `validateCode`, `parseSettings` (Task 2); `owner`, `rateLimit`, `json`, `fail` (`lib/papers.ts`); `canManage` (`lib/workspace.ts`); `initDocs` (`lib/documents.ts`), `initExperiments` (`lib/experiments.ts`).
- Produces:
  - `export function initRunRequests(): Promise<void>` — creates the table from spec §5 (FKs to `compute_accounts`, `documents`, `experiment_runs`; index on `(workspace_id, status)`), enables RLS.
  - `export type RunRequest = { id: number; account_id: number; account_label: string; ref: string | null; new_title: string | null; kernel_type: string; settings: PushSettings; summary: string; idea_id: number | null; idea_title: string | null; status: string; requested_by_name: string | null; requested_via: "mcp" | "api" | "web"; reviewed_by_name: string | null; reviewed_at: string | null; review_note: string | null; version: number | null; run_id: number | null; error: string | null; created_at: string; updated_at: string; mine: boolean; can_cancel: boolean }` (list omits `code`; `getRequest(..., { withCode: true })` adds `code`)
  - `createRequest(s: Scope, via: "mcp" | "api" | "web", f: Record<string, unknown>): Promise<RunRequest>`
  - `listRequests(s: Scope, o: { status?: string; idea_id?: number; limit?: number; offset?: number }): Promise<{ items: RunRequest[]; total: number; pending: number }>` (runs the 7-day expiry sweep first)
  - `getRequest(s: Scope, id: unknown, o?: { withCode?: boolean }): Promise<RunRequest & { code?: string }>`
  - `rejectRequest(s: Scope, id: unknown, note: unknown)`, `cancelRequest(s: Scope, id: unknown)`
  - `export const reqId = (v: unknown) => number` (404 "Không tìm thấy yêu cầu chạy.")

- [ ] **Step 1: Write failing tests** in `run-requests-isolation.mjs`:
  - anonymous list/create → 401.
  - user A (session) creates a connection with a dummy token (`POST /api/accounts`), an idea doc (`POST /api/docs {kind:"idea"}`) and a token; creates a request via REST with Bearer → 200, `status: "pending"`, `requested_via: "api"`.
  - user B (other workspace) `GET /api/run-requests/:id` → 404; B's list does not contain it.
  - validation 422: `account_id` of B's connection; `idea_id` of a `report` doc; `machine: "a100"`; `bad ipynb` (`kernel_type: "notebook"`, `code: "print(1)"`); code > 2 MB; neither `ref` nor `new_title`; `ref` whose owner ≠ connection username.
  - reject via Bearer → 401; reject via session with note → `rejected`, `review_note` echoed; reject again → 409.
  - cancel: another member of A's workspace (invite B2 into A's workspace via the organization invite API used in `auth-isolation.mjs`) cannot cancel A's request (403) unless owner/admin; A cancels → `cancelled`.
  - 51st pending in a workspace → 429-or-422 with message containing "50".
  - `idea deleted`: delete the idea doc, `GET` the request → 200 with `idea_id: null`.
  - expiry: when `RUNREQ_TEST_DB` (the disposable DB URL) is set, back-date one request with `pg` (`UPDATE run_requests SET created_at=now()-interval '8 days'`), then list → it shows `expired`; skipped with a printed note otherwise.
- [ ] **Step 2: Run against a disposable server** (`docker run postgres:17-alpine`, `scripts/migrate-auth.mjs`, `next start -p 3004`) → fails (404 routes).
- [ ] **Step 3: Implement** `lib/run-requests.ts` and the four route files (route shape exactly like `app/api/runs/[id]/route.ts`). Reject and cancel use `UPDATE … WHERE id=$1 AND workspace_id=$2 AND status='pending' RETURNING` and 409 when no row.
- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `git commit -m "Add run requests: create, list, review, reject, cancel"`.

### Task 4: Approve, run-now and the Kaggle push

**Files:**
- Modify: `apps/web/lib/run-requests.ts` (add push functions)
- Create: `apps/web/app/api/run-requests/[id]/approve/route.ts` (POST, session only)
- Create: `apps/web/app/api/run-requests/run-now/route.ts` (POST, session only)
- Test: `apps/web/tests/run-requests-isolation.mjs` (extend)

**Interfaces:**
- Consumes: `buildSaveKernelBody` (Task 2), `kaggleCall`, `decryptToken`, `normalizeQuota` (`lib/server.ts`), `updateDoc` semantics for the idea status (do a direct `UPDATE documents SET status='trying' WHERE id=$1 AND kind='idea' AND status='new'`).
- Produces:
  - `approveRequest(s: Scope, id: unknown): Promise<RunRequest>`: claim with `UPDATE … SET status='approved', reviewed_by=$user, reviewed_at=now() WHERE … status='pending' RETURNING *` (409 when none) → if GPU/TPU, `GetAcceleratorQuotaStatistics` and refuse when remaining ≤ 0 → `GetKernel` when `ref` → `SaveKernel` → `running` with `version`, `ref`, `error=NULL`; idea `new → trying`. Any thrown error → `status='pending', error=<message>` and rethrow as 502 with the message.
  - `runNow(s: Scope, f: { account_id: unknown; ref?: unknown; run_id?: unknown; settings?: unknown; idea_id?: unknown }): Promise<RunRequest>`: `ref` → code from `GetKernel().blob.source`; `run_id` → `experiment_runs.code` of that run (422 "Run này không lưu code." when null) on its `account_id`/`ref`. Inserts with `requested_via='web'`, then the same push path as approve.

- [ ] **Step 1: Write failing tests:**
  - `token cannot approve`: `POST /approve` and `/run-now` with Bearer only → 401; row still `pending`.
  - approve via session with the dummy-token connection → 502, then `GET` shows `status: "pending"` and a non-empty `error` (proves every check passed and Kaggle was reached).
  - `double approve`: two concurrent session approves of a fresh request → statuses are one 502 and one 409 (never two 502s).
  - approve a `rejected` request → 409. B approves A's request → 404.
  - run-now with `run_id` of a manual run (no code) → 422.
  - approve rate limit: 11 approves in a minute → the 11th is 429.
- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `git commit -m "Approve run requests and push to Kaggle"`.

### Task 5: Status, capture and idea linking

**Files:**
- Modify: `apps/web/lib/run-requests.ts`
- Create: `apps/web/app/api/run-requests/[id]/status/route.ts` (GET, `allowToken: true`)
- Create: `apps/web/app/api/run-requests/[id]/base/route.ts` (GET, current Kaggle source for the diff; `allowToken: true`)
- Modify: `apps/web/app/api/[...path]/route.ts:118` (after a successful `captureRun` in `notebook-status`, call `linkCapturedRun`)

**Interfaces:**
- Consumes: `captureRun(s, account, ref, { version, status, failureMessage })` from `lib/experiments.ts`, `TERMINAL`.
- Produces:
  - `refreshRequest(s: Scope, id: unknown): Promise<RunRequest>`: only acts on `running`; `GetKernelSessionStatus`; on terminal → `captureRun` with the stored `version` → `done` (or `failed` when status is `error`/`cancel_acknowledged`), `run_id`, then `linkCapturedRun`. Capture errors are stored in `error` but still finish the status.
  - `linkCapturedRun(workspaceId: string, accountId: number, ref: string, version: number | null, runId: number): Promise<void>`: finds `running` requests with that account/ref/version (version NULL matches the newest `running` for that ref), sets `run_id`, inserts `document_runs (idea_id, run_id) ON CONFLICT DO NOTHING`.
  - `currentSource(s: Scope, id: unknown): Promise<{ code: string | null }>` (null for a new notebook).

- [ ] **Step 1: Write failing tests:** status of a `pending` request returns it unchanged (no Kaggle call); B → 404; `/base` with Bearer of A for a `ref` on the dummy connection → 502 with a Vietnamese message (no token leak: response body does not contain the dummy token string).
- [ ] **Step 2: Run** → fails. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `git commit -m "Follow pushed runs and link captured runs to ideas"`.

### Task 6: MCP tools

**Files:**
- Modify: `apps/web/app/api/mcp/route.ts` (TOOLS array + switch; bump `serverInfo.version` to `0.6.0`)
- Test: `apps/web/tests/run-requests-isolation.mjs` (extend)

**Interfaces:**
- Consumes: `createRequest(s, "mcp", args)`, `listRequests`, `getRequest` + `refreshRequest` (get refreshes when `running`), `cancelRequest`.
- Produces tools: `push_notebook` (description starts "ĐỀ XUẤT chạy notebook trên Kaggle; KHÔNG chạy ngay: một thành viên phải duyệt trên web." and mentions `docs/ros_tracker.py`; returns `{ id, status, review_url }` where `review_url = BETTER_AUTH_URL + "/run-requests/" + id`), `list_run_requests`, `get_run_request`, `cancel_run_request` (`destructiveHint: true`).

- [ ] **Step 1: Failing tests:** `tools/list` contains the 4 names and no tool name containing `approve`; `push_notebook` → `pending` and `requested_via: "mcp"`; `get_run_request` after a session reject shows `review_note`; `cancel_run_request` on another user's request → isError.
- [ ] **Step 2–4:** run, implement, run.
- [ ] **Step 5: Commit** `git commit -m "Add MCP tools for run requests"`.

### Task 7: Shared LiveLog and the review page

**Files:**
- Create: `apps/web/app/live-log.tsx` — `export default function LiveLog({ accountId, refName, version, active }: { accountId: number; refName: string; version: number | null; active: boolean })`: when `active`, streams `notebook-logs-stream` (logic moved from `logs-screen.tsx` `follow`/`stop`, same 256 KB trimming and SSE parsing); otherwise loads `notebook-logs?ref=<ref>/<version>` once.
- Modify: `apps/web/app/logs-screen.tsx` to use `LiveLog` for the follow mode (behavior unchanged).
- Create: `apps/web/app/run-requests/[id]/page.tsx` (client page like `app/runs/[id]/code/page.tsx`): header (title, notebook, machine, idea link, requester, summary, status, error), tabs **Code** (`NotebookView` for notebooks, `<pre>` for scripts) / **Diff** (`diffLines` from `diff` over code cells joined, current source from `/base`) / **Log** (`LiveLog`, `active` when `running`); buttons **Duyệt & chạy** and **Từ chối…** (textarea note) when `pending`; polls `/status` every 30 s while `running`.
- Modify: `apps/web/package.json` (`npm install diff@^8` and `@types/diff` only if v8 lacks types)
- Modify: `apps/web/app/runs.css` (`rq-*` classes)

- [ ] **Step 1:** `npm install diff`; `npm run build` passes.
- [ ] **Step 2:** Playwright against the disposable server: open a pending request page, see code and the summary; reject with a note → status shows "Đã từ chối"; Logs screen "Theo dõi trực tiếp" still opens the stream (dummy token → the existing error message).
- [ ] **Step 3: Commit** `git commit -m "Add the run request review page and a shared live log"`.

### Task 8: Runs tabs, sidebar badge, Run buttons

**Files:**
- Modify: `apps/web/app/runs-screen.tsx` — tabs **Run** (current view) / **Chờ duyệt (n)** / **Đang chạy**; cards as in spec §7 linking to `/run-requests/:id` in a new tab; the Đang chạy tab polls `/status` for each running request every 30 s while visible.
- Modify: `apps/web/app/page.tsx` — badge with `pending` count next to "Thí nghiệm" (from `GET /api/run-requests?status=pending&limit=1` on load and every 60 s).
- Modify: `apps/web/app/connector-screens.tsx` — notebooks table: **Chạy** button → modal (machine select T4×2/L4/TPU/CPU with "Giữ như hiện tại" default, internet checkbox, idea select from `GET /api/docs?kind=idea`) → `POST /api/run-requests/run-now` → navigate to Logs with that notebook selected.
- Modify: `apps/web/app/runs/[id]/code/page.tsx` — **Chạy lại version này** → `run-now { run_id }` → open the new request page.
- Modify: `apps/web/app/docs/[id]/page.tsx` — for ideas, list its requests (`GET /api/run-requests?idea_id=`) with status and links.

- [ ] **Step 1:** `npm run build` passes.
- [ ] **Step 2:** Playwright: pending badge count matches; Chờ duyệt tab lists the request; Chạy modal submits (dummy token → error message shown, no navigation).
- [ ] **Step 3: Commit** `git commit -m "Add run request tabs, badge and Run buttons"`.

### Task 9: Docs and the real Kaggle run

**Files:**
- Modify: `CLAUDE.md` (Architecture bullet for run requests; MCP count 28 → 32; tests line for `run-requests-isolation.mjs` and `save-kernel.test.mjs`), `README.md` (short section "Chạy notebook từ app"), `docs/KAGGLE_CONNECTOR_ROADMAP.md` (tick: push + approval; keep "kiểm chứng log trực tiếp" until Step 2 passes), `apps/web/app/api/mcp/route.ts` initialize `instructions` (mention the approval rule).

- [ ] **Step 1:** Update docs; `npm run build`.
- [ ] **Step 2: Real run** on prod-equivalent local (shared key): via MCP `push_notebook` on the Task 1 notebook with CPU and an idea → approve on the web → live log shows output → status `done` → run appears in Thí nghiệm and on the idea page; idea status `trying`.
- [ ] **Step 3: Commit** `git commit -m "Document notebook push and approval"`; push the branch and open the PR.

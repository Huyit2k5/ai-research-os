import "server-only";
import { createHash } from "node:crypto";
import { AppError, db, decryptToken, initialize, kaggleCall } from "./server";
import { initPapers, parseTags as parsePaperTags } from "./papers";
import { canManage, type Scope } from "./workspace";

/*
 * Experiment runs: metrics + config captured from Kaggle notebook output, or logged manually (Colab/local/MCP).
 * Notebook contract (see docs/EXPERIMENT_TRACKING.md):
 *   - file  /kaggle/working/ros_run.json = { "config": {...}, "metrics": {...}, "history": [{ "step": n, "<metric>": number, ... }] }
 *   - log lines "@@ROS_CONFIG {json}" and "@@ROS_METRIC {json}" (fallback when the file is missing, e.g. crash).
 */
let ready: Promise<unknown> | undefined;
export function initExperiments() {
  ready ??= (async () => {
    await initialize();
    await initPapers();
    await db.query(`
    CREATE TABLE IF NOT EXISTS experiment_runs (id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, account_id INTEGER REFERENCES compute_accounts(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT 'kaggle', ref TEXT, version INTEGER, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', failure_message TEXT NOT NULL DEFAULT '', config JSONB NOT NULL DEFAULT '{}'::jsonb, metrics JSONB NOT NULL DEFAULT '{}'::jsonb, history JSONB NOT NULL DEFAULT '[]'::jsonb, env JSONB NOT NULL DEFAULT '{}'::jsonb, code TEXT, code_hash TEXT, captured_from TEXT NOT NULL DEFAULT 'none', notes TEXT NOT NULL DEFAULT '', tags TEXT[] NOT NULL DEFAULT '{}', paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL, run_at TIMESTAMPTZ, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    DROP INDEX IF EXISTS experiment_runs_kaggle_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_kaggle_acct_idx ON experiment_runs(account_id, ref, version) WHERE source='kaggle' AND version IS NOT NULL;
    CREATE INDEX IF NOT EXISTS experiment_runs_owner_idx ON experiment_runs(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS experiment_runs_tags_idx ON experiment_runs USING GIN (tags);
    -- Workspaces: runs are shared per workspace (a Kaggle run lives in its connection's workspace); owner_id is who captured/logged it.
    ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS experiment_runs_ws_idx ON experiment_runs(workspace_id, created_at DESC);
    ALTER TABLE experiment_runs ENABLE ROW LEVEL SECURITY`);
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

/** MAX_RUNS is per workspace. */
export const MAX_RUNS = 10000,
  MAX_HISTORY = 5000,
  TERMINAL = new Set(["complete", "error", "cancel_acknowledged"]);
export const RUN_STATUSES = [
  "queued",
  "running",
  "complete",
  "error",
  "cancel_requested",
  "cancel_acknowledged",
  "unknown",
] as const;
// owner_id is read only to compute can_delete and is stripped by shape(); created_by is the creator's display name (null if the user is gone).
const LIST_FIELDS = `id, account_id, source, ref, version, name, status, failure_message, config, metrics, env, captured_from, notes, tags, paper_id, run_at, captured_at, created_at, jsonb_array_length(history) AS history_points, owner_id, (SELECT u.name FROM "user" u WHERE u.id=experiment_runs.owner_id) AS created_by`;
export type RunRow = Record<string, unknown> & {
  id: number;
  name: string;
  config: Record<string, Scalar>;
  metrics: Record<string, number>;
  created_by: string | null;
  can_delete: boolean;
};
type Scalar = string | number | boolean | null;
const shape = (s: Scope, r: Record<string, unknown>) => {
  const { owner_id, ...rest } = r;
  return { ...rest, created_by: rest.created_by ?? null, can_delete: canManage(s, owner_id) } as RunRow;
};

const parseTags = (raw: unknown) => {
  if (
    Array.isArray(raw) &&
    raw.length > 20 &&
    new Set(raw.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))).size > 20
  )
    throw new AppError(422, "Mỗi run tối đa 20 tag.");
  return parsePaperTags(raw);
};
const clip = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const idOf = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new AppError(404, "Không tìm thấy run.");
  return n;
};
const safeKey = (k: string) =>
  k
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 100);

/** Flattens nested config to dot keys (optimizer.lr) with scalar values; arrays become JSON text. Caps at 200 keys. */
export function sanitizeConfig(raw: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (!isObj(v)) return;
    for (const [k0, x] of Object.entries(v)) {
      if (Object.keys(out).length >= 200) return;
      const k = safeKey(prefix ? `${prefix}.${k0}` : k0);
      if (!k) continue;
      if (isObj(x) && depth < 3) walk(x, k, depth + 1);
      else if (typeof x === "number") {
        if (Number.isFinite(x)) out[k] = x;
      } else if (typeof x === "boolean" || x === null) out[k] = x;
      else if (typeof x === "string") out[k] = x.slice(0, 1000);
      else if (x !== undefined) {
        try {
          out[k] = JSON.stringify(x).slice(0, 1000);
        } catch {}
      }
    }
  };
  walk(raw, "", 0);
  return out;
}
/** Keeps finite numeric metrics only (numeric strings are converted). Caps at 100 keys. */
export function sanitizeMetrics(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [k0, x] of Object.entries(raw)) {
    if (Object.keys(out).length >= 100) break;
    const k = safeKey(k0),
      n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
    if (k && k !== "step" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
export function sanitizeHistory(raw: unknown): Record<string, number>[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_HISTORY).flatMap((p) => {
    if (!isObj(p)) return [];
    const m = sanitizeMetrics(p),
      step = Number(p.step);
    if (!Object.keys(m).length) return [];
    return [{ ...(Number.isFinite(step) ? { step } : {}), ...m }];
  });
}

/** Kaggle's log is a JSON array of {stream_name,time,data}; fall back to raw text. */
export function logText(log: unknown) {
  if (typeof log !== "string") return "";
  try {
    const a: unknown = JSON.parse(log);
    if (Array.isArray(a)) return a.map((e) => (isObj(e) && typeof e.data === "string" ? e.data : "")).join("");
  } catch {}
  return log;
}
/** Rebuilds config/metrics/history from "@@ROS_CONFIG {json}" / "@@ROS_METRIC {json}" lines. */
export function parseLogMarkers(text: string) {
  let config: Record<string, unknown> = {};
  const metrics: Record<string, number> = {},
    history: unknown[] = [];
  let found = false;
  for (const m of text.matchAll(/@@ROS_(CONFIG|METRIC)\s+(\{.*\})\s*$/gm)) {
    let v: unknown;
    try {
      v = JSON.parse(m[2]);
    } catch {
      continue;
    }
    if (!isObj(v)) continue;
    found = true;
    if (m[1] === "CONFIG") config = { ...config, ...v };
    else {
      const x = sanitizeMetrics(v);
      Object.assign(metrics, x);
      if (v.step !== undefined && v.step !== null) history.push(v);
    }
  }
  return found ? { config: sanitizeConfig(config), metrics, history: sanitizeHistory(history) } : null;
}

const OUTPUT_HOST = /(^|\.)(googleapis\.com|googleusercontent\.com|kaggle\.com|kaggleusercontent\.com|kaggle\.net)$/i;
/** Downloads ros_run.json from Kaggle output storage (https + Kaggle/Google hosts only, max 2 MB). */
async function fetchRunFile(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !OUTPUT_HOST.test(u.hostname)) return null;
  try {
    const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!r.ok || !r.body || Number(r.headers.get("content-length") || 0) > 2 * 1024 * 1024) return null;
    const reader = r.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.length;
      if (size > 2 * 1024 * 1024) {
        void reader.cancel();
        return null;
      }
      parts.push(c.value);
    }
    const v: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return isObj(v)
      ? { config: sanitizeConfig(v.config), metrics: sanitizeMetrics(v.metrics), history: sanitizeHistory(v.history) }
      : null;
  } catch {
    return null;
  }
}

function envFrom(meta: Record<string, unknown>) {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 30) : undefined);
  const e: Record<string, unknown> = {
    title: clip(meta.title, 300),
    language: clip(meta.language, 30),
    kernel_type: clip(meta.kernelType, 30),
    accelerator: clip(meta.machineShape, 60) ?? (meta.enableTpu ? "TPU" : meta.enableGpu ? "GPU" : null),
    enable_internet: typeof meta.enableInternet === "boolean" ? meta.enableInternet : null,
    datasets: names(meta.datasetDataSources),
    competitions: names(meta.competitionDataSources),
    kernels: names(meta.kernelDataSources),
    models: names(meta.modelDataSources),
    last_run_time: clip(meta.lastRunTime, 40),
  };
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined));
}

export type CaptureResult = { skipped: true; reason: string } | { skipped: false; run: RunRow; created: boolean };
/**
 * Captures the latest (or given) version of a Kaggle notebook into experiment_runs. Idempotent per (account, ref, version).
 * Never overwrites user-edited fields (name, notes, tags, paper_id); a re-capture that finds no data keeps the stored config/metrics.
 */
export async function captureRun(
  s: Scope,
  account: { id: number; credential: string; workspace_id: string },
  ref: string,
  opts: { version?: number; status?: string; failureMessage?: string; force?: boolean } = {},
): Promise<CaptureResult> {
  await initExperiments();
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref))
    throw new AppError(422, "Tên notebook không hợp lệ. Hãy dùng owner/notebook.");
  const ownerId = s.userId,
    workspaceId = account.workspace_id;
  if (
    !opts.force &&
    (
      await db.query(
        "SELECT 1 FROM experiment_runs WHERE account_id=$1 AND ref=$2 AND captured_at > NOW() - INTERVAL '2 minutes' LIMIT 1",
        [account.id, ref],
      )
    ).rows.length
  )
    return { skipped: true, reason: "Run vừa được thu cách đây chưa tới 2 phút." };
  const token = decryptToken(account.credential),
    [userName, kernelSlug] = ref.split("/");
  let status = opts.status,
    failure = opts.failureMessage ?? "";
  if (!status && opts.version === undefined) {
    const s = await kaggleCall(token, "GetKernelSessionStatus", { userName, kernelSlug });
    status =
      (typeof s.status === "string" ? s.status : "").replace(/^KERNEL_WORKER_STATUS_/, "").toLowerCase() || "unknown";
    failure = typeof s.failureMessage === "string" ? s.failureMessage : "";
  }
  status ??= "unknown";
  if (opts.version === undefined && !TERMINAL.has(status)) return { skipped: true, reason: "Notebook chưa chạy xong." };
  // GetKernel gives version number, environment and a code snapshot; it is best-effort (unverified against every Kaggle response shape).
  let meta: Record<string, unknown> = {},
    source: string | null = null;
  try {
    const k = await kaggleCall(token, "GetKernel", { userName, kernelSlug });
    if (isObj(k.metadata)) meta = k.metadata;
    if (isObj(k.blob) && typeof k.blob.source === "string") source = k.blob.source;
  } catch {}
  const current = Number(meta.currentVersionNumber),
    version = opts.version ?? (Number.isInteger(current) && current > 0 ? current : null);
  if (opts.version !== undefined && opts.version !== current) source = null; // code snapshot only matches the current version
  const req = { userName, kernelSlug, ...(opts.version !== undefined ? { versionLabel: String(opts.version) } : {}) },
    isRunFile = (f: Record<string, unknown>) =>
      typeof f.fileName === "string" && /(^|\/)ros_run\.json$/.test(f.fileName) && typeof f.url === "string";
  const out = await kaggleCall(token, "ListKernelSessionOutput", req);
  // Output files are paged; look at up to 3 more pages for ros_run.json when a notebook writes many files.
  let page = out,
    file = (Array.isArray(out.files) ? out.files.filter(isObj) : []).find(isRunFile);
  for (let i = 0; !file && i < 3 && typeof page.nextPageToken === "string" && page.nextPageToken; i++) {
    page = await kaggleCall(token, "ListKernelSessionOutput", { ...req, pageToken: page.nextPageToken });
    file = (Array.isArray(page.files) ? page.files.filter(isObj) : []).find(isRunFile);
  }
  let data = file ? await fetchRunFile(String(file.url)) : null,
    from = data ? "run_json" : "none";
  const markers = parseLogMarkers(logText(out.log));
  if (!data && markers) {
    data = markers;
    from = "log";
  } else if (data && markers) {
    data.config = { ...markers.config, ...data.config };
    if (!data.history.length) data.history = markers.history;
    if (!Object.keys(data.metrics).length) data.metrics = markers.metrics;
  }
  const lastRun = new Date(String(meta.lastRunTime ?? "")),
    runAt = Number.isNaN(lastRun.getTime()) ? null : lastRun.toISOString();
  const env = envFrom(meta),
    name = `${clip(meta.title, 200) ?? kernelSlug}${version ? ` v${version}` : ""}`;
  const code = source ? source.slice(0, 300_000) : null,
    codeHash = source ? createHash("sha256").update(source).digest("hex") : null;
  const vals = [
    ownerId,
    account.id,
    ref,
    version,
    name,
    status,
    failure.slice(0, 2000),
    JSON.stringify(data?.config ?? {}),
    JSON.stringify(data?.metrics ?? {}),
    JSON.stringify(data?.history ?? []),
    JSON.stringify(env),
    code,
    codeHash,
    from,
    runAt,
    workspaceId,
  ];
  // x = the freshly captured values (EXCLUDED on upsert, a VALUES row on plain update).
  const set = (x: string) => {
    const keep = (c: string) => `${c}=CASE WHEN ${x}.captured_from='none' THEN experiment_runs.${c} ELSE ${x}.${c} END`;
    return `status=CASE WHEN ${x}.status='unknown' THEN experiment_runs.status ELSE ${x}.status END, failure_message=CASE WHEN ${x}.status='unknown' THEN experiment_runs.failure_message ELSE ${x}.failure_message END, ${keep("config")}, ${keep("metrics")}, ${keep("history")}, ${keep("captured_from")}, env=${x}.env, workspace_id=COALESCE(experiment_runs.workspace_id, ${x}.workspace_id), code=COALESCE(${x}.code, experiment_runs.code), code_hash=COALESCE(${x}.code_hash, experiment_runs.code_hash), run_at=COALESCE(${x}.run_at, experiment_runs.run_at), captured_at=NOW()`;
  };
  const insert =
    "INSERT INTO experiment_runs (owner_id, account_id, source, ref, version, name, status, failure_message, config, metrics, history, env, code, code_hash, captured_from, run_at, workspace_id) VALUES ($1,$2,'kaggle',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)";
  // Without a version number the newest unversioned row for this notebook is updated in place.
  const prev =
    version === null
      ? (
          await db.query(
            "SELECT id FROM experiment_runs WHERE account_id=$1 AND ref=$2 AND source='kaggle' AND version IS NULL ORDER BY id DESC LIMIT 1",
            [account.id, ref],
          )
        ).rows[0]
      : undefined;
  if (!prev) await assertRoom(workspaceId, version === null ? undefined : { accountId: account.id, ref, version });
  let row;
  if (version !== null)
    row = (
      await db.query(
        `${insert} ON CONFLICT (account_id, ref, version) WHERE source='kaggle' AND version IS NOT NULL DO UPDATE SET ${set("EXCLUDED")} RETURNING id, (xmax = 0) AS created`,
        vals,
      )
    ).rows[0];
  else {
    if (prev) {
      await db.query(
        `UPDATE experiment_runs SET ${set("x")} FROM (SELECT $2::text AS status, $3::text AS failure_message, $4::jsonb AS config, $5::jsonb AS metrics, $6::jsonb AS history, $7::jsonb AS env, $8::text AS code, $9::text AS code_hash, $10::text AS captured_from, $11::timestamptz AS run_at, $12::text AS workspace_id) x WHERE experiment_runs.id=$1`,
        [prev.id, ...vals.slice(5, 16)],
      );
      row = { id: prev.id, created: false };
    } else row = { ...(await db.query(`${insert} RETURNING id`, vals)).rows[0], created: true };
  }
  return { skipped: false, run: await getRun({ ...s, workspaceId }, row.id), created: Boolean(row.created) };
}

async function assertRoom(workspaceId: string, existing?: { accountId: number; ref: string; version: number }) {
  if (
    existing &&
    (
      await db.query(
        "SELECT 1 FROM experiment_runs WHERE account_id=$1 AND ref=$2 AND version=$3 AND source='kaggle'",
        [existing.accountId, existing.ref, existing.version],
      )
    ).rows.length
  )
    return;
  if (
    Number(
      (await db.query("SELECT COUNT(*) FROM experiment_runs WHERE workspace_id=$1", [workspaceId])).rows[0].count,
    ) >= MAX_RUNS
  )
    throw new AppError(409, `Workspace đã đạt giới hạn ${MAX_RUNS} run. Hãy xóa bớt run cũ.`);
}

/** Captures the latest run of a notebook given an account id string (used by REST + MCP). Any member of the connection's workspace may capture. */
export async function captureRunFor(
  s: Scope,
  accountIdRaw: unknown,
  ref: unknown,
  opts: { version?: unknown; force?: boolean } = {},
) {
  await initExperiments();
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId) || accountId < 1 || accountId > 2147483647)
    throw new AppError(404, "Không tìm thấy kết nối.");
  const account = (
    await db.query("SELECT id, credential, workspace_id FROM compute_accounts WHERE id=$1 AND workspace_id=$2", [
      accountId,
      s.workspaceId,
    ])
  ).rows[0];
  if (!account) throw new AppError(404, "Không tìm thấy kết nối.");
  const v =
    opts.version === undefined || opts.version === null || opts.version === "" ? undefined : Number(opts.version);
  if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new AppError(422, "Version không hợp lệ.");
  return captureRun(s, account, String(ref ?? ""), { version: v, force: opts.force });
}

export type RunListOpts = {
  q?: string;
  ref?: string;
  tag?: string;
  status?: string;
  source?: string;
  account?: number;
  sort?: string;
  metric?: string;
  order?: string;
  limit?: number;
  offset?: number;
};
export async function listRuns(s: Scope, o: RunListOpts = {}) {
  await initExperiments();
  const q = (o.q ?? "").trim().slice(0, 200),
    limit = Math.min(Math.max(Math.trunc(o.limit ?? 50) || 50, 1), 200),
    offset = Math.max(Math.trunc(o.offset ?? 0) || 0, 0);
  const metric = clip(o.metric, 100),
    dir = o.order === "asc" ? "ASC" : "DESC";
  const where =
    "workspace_id=$1 AND ($2='' OR name ILIKE '%'||$2||'%' OR ref ILIKE '%'||$2||'%' OR notes ILIKE '%'||$2||'%') AND ($3::text IS NULL OR ref=$3) AND ($4::text IS NULL OR $4=ANY(tags)) AND ($5::text IS NULL OR status=$5) AND ($6::text IS NULL OR source=$6) AND ($7::int IS NULL OR account_id=$7)";
  const params = [
    s.workspaceId,
    q,
    clip(o.ref, 200),
    clip(o.tag, 40),
    clip(o.status, 30),
    clip(o.source, 20),
    Number.isInteger(o.account) && o.account! > 0 && o.account! <= 2147483647 ? o.account : null,
  ];
  const order =
    o.sort === "metric" && metric
      ? `CASE WHEN jsonb_typeof(metrics->$8)='number' THEN (metrics->>$8)::float8 END ${dir} NULLS LAST, id DESC`
      : o.sort === "oldest"
        ? "COALESCE(run_at, created_at) ASC, id ASC"
        : "COALESCE(run_at, created_at) DESC, id DESC";
  const all = metric && o.sort === "metric" ? [...params, metric] : params;
  const [items, total] = await Promise.all([
    db.query(
      `SELECT ${LIST_FIELDS} FROM experiment_runs WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      all,
    ),
    db.query(`SELECT COUNT(*) FROM experiment_runs WHERE ${where}`, params),
  ]);
  return { total: Number(total.rows[0].count), offset, limit, items: items.rows.map((r) => shape(s, r)) };
}

export async function getRun(s: Scope, idRaw: unknown, opts: { withCode?: boolean } = {}) {
  await initExperiments();
  const row = (
    await db.query(
      `SELECT ${LIST_FIELDS}, history, code_hash${opts.withCode ? ", code" : ""} FROM experiment_runs WHERE id=$1 AND workspace_id=$2`,
      [idOf(idRaw), s.workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "Không tìm thấy run.");
  return shape(s, row);
}

async function paperIdFor(s: Scope, raw: unknown) {
  if (raw === null || raw === "") return null;
  const id = Number(raw);
  if (
    !Number.isInteger(id) ||
    id < 1 ||
    id > 2147483647 ||
    !(await db.query("SELECT 1 FROM papers WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rows.length
  )
    throw new AppError(422, "Paper liên kết không tồn tại trong thư viện.");
  return id;
}
/** Updates user-editable fields only (any workspace member); config/metrics are editable for manual runs. Only provided fields change. */
export async function updateRun(s: Scope, idRaw: unknown, f: Record<string, unknown>) {
  const run = await getRun(s, idRaw),
    sets: string[] = [],
    vals: unknown[] = [run.id, s.workspaceId];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  };
  if (f.name !== undefined) {
    const n = clip(f.name, 200);
    if (!n) throw new AppError(422, "Tên run không hợp lệ.");
    add("name", n);
  }
  if (f.notes !== undefined) {
    if (typeof f.notes !== "string") throw new AppError(422, "Ghi chú không hợp lệ.");
    add("notes", f.notes.slice(0, 20000));
  }
  if (f.tags !== undefined) add("tags", parseTags(f.tags));
  if (f.paper_id !== undefined) add("paper_id", await paperIdFor(s, f.paper_id));
  if (run.source === "manual") {
    if (f.config !== undefined) add("config", JSON.stringify(sanitizeConfig(f.config)));
    if (f.metrics !== undefined) add("metrics", JSON.stringify(sanitizeMetrics(f.metrics)));
    if (f.status !== undefined) {
      if (!RUN_STATUSES.includes(f.status as never)) throw new AppError(422, "Trạng thái không hợp lệ.");
      add("status", f.status);
    }
  } else if (f.config !== undefined || f.metrics !== undefined || f.status !== undefined)
    throw new AppError(422, "Config, metrics và trạng thái của run Kaggle được thu tự động, không sửa tay được.");
  if (!sets.length) return run;
  await db.query(`UPDATE experiment_runs SET ${sets.join(", ")} WHERE id=$1 AND workspace_id=$2`, vals);
  return getRun(s, run.id);
}

/** Only the run's creator or a workspace owner/admin may delete it. */
export async function deleteRun(s: Scope, idRaw: unknown) {
  await initExperiments();
  const id = idOf(idRaw),
    run = (await db.query("SELECT owner_id FROM experiment_runs WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId]))
      .rows[0];
  if (!run) throw new AppError(404, "Không tìm thấy run.");
  if (!canManage(s, run.owner_id)) throw new AppError(403, "Chỉ người tạo run hoặc quản trị workspace mới được xóa.");
  if (!(await db.query("DELETE FROM experiment_runs WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rowCount)
    throw new AppError(404, "Không tìm thấy run.");
}

/** Records a run that did not run on a connected Kaggle account (Colab, local GPU, told to Claude). */
export async function logManualRun(s: Scope, f: Record<string, unknown>) {
  await initExperiments();
  await assertRoom(s.workspaceId);
  const name = clip(f.name, 200);
  if (!name) throw new AppError(422, "Tên run không hợp lệ.");
  const status = f.status === undefined ? "complete" : f.status;
  if (!RUN_STATUSES.includes(status as never)) throw new AppError(422, "Trạng thái không hợp lệ.");
  const runAt = f.run_at === undefined || f.run_at === null || f.run_at === "" ? null : new Date(String(f.run_at));
  if (runAt && Number.isNaN(runAt.getTime())) throw new AppError(422, "Thời điểm chạy không hợp lệ.");
  const id = (
    await db.query(
      "INSERT INTO experiment_runs (owner_id, source, name, status, config, metrics, history, notes, tags, paper_id, run_at, captured_from, env, workspace_id) VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,$12) RETURNING id",
      [
        s.userId,
        name,
        status,
        JSON.stringify(sanitizeConfig(f.config)),
        JSON.stringify(sanitizeMetrics(f.metrics)),
        JSON.stringify(sanitizeHistory(f.history)),
        typeof f.notes === "string" ? f.notes.slice(0, 20000) : "",
        parseTags(f.tags ?? []),
        await paperIdFor(s, f.paper_id ?? null),
        runAt?.toISOString() ?? null,
        JSON.stringify(clip(f.platform, 60) ? { platform: clip(f.platform, 60) } : {}),
        s.workspaceId,
      ],
    )
  ).rows[0].id;
  return getRun(s, id);
}

const LOWER_BETTER = /(loss|err|error|mae|mse|rmse|mape|perplexity|ppl|wer|cer|fid|latency|time|duration)/i;
export const betterDirection = (metric: string) => (LOWER_BETTER.test(metric) ? "lower" : "higher");
/** Side-by-side view of 2–10 runs: config keys that differ, shared config, and every metric with the best run marked. */
export async function compareRuns(s: Scope, idsRaw: unknown) {
  await initExperiments();
  const ids = [
    ...new Set(
      (Array.isArray(idsRaw) ? idsRaw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647),
    ),
  ].slice(0, 10);
  if (ids.length < 2) throw new AppError(422, "Cần chọn từ 2 đến 10 run để so sánh.");
  const rows = (
    await db.query(`SELECT ${LIST_FIELDS} FROM experiment_runs WHERE workspace_id=$1 AND id=ANY($2::int[])`, [
      s.workspaceId,
      ids,
    ])
  ).rows.map((r) => shape(s, r));
  if (rows.length !== ids.length) throw new AppError(404, "Không tìm thấy một số run.");
  const runs = ids.map((id) => rows.find((r) => r.id === id)!),
    keys = (pick: (r: RunRow) => Record<string, unknown>) =>
      [...new Set(runs.flatMap((r) => Object.keys(pick(r))))].sort();
  const same = (vs: unknown[]) => vs.every((v) => JSON.stringify(v) === JSON.stringify(vs[0]));
  const configRows = keys((r) => r.config).map((key) => ({
    key,
    values: runs.map((r) => (key in r.config ? r.config[key] : null)),
  }));
  const metrics = keys((r) => r.metrics).map((key) => {
    const values = runs.map((r) => (typeof r.metrics[key] === "number" ? r.metrics[key] : null)),
      better = betterDirection(key),
      nums = values.filter((v): v is number => v !== null);
    const best = nums.length ? (better === "lower" ? Math.min(...nums) : Math.max(...nums)) : null;
    return { key, better, values, best_index: best === null || nums.length < 2 ? null : values.indexOf(best) };
  });
  return {
    runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      ref: r.ref,
      version: r.version,
      status: r.status,
      run_at: r.run_at,
      env: r.env,
      tags: r.tags,
      created_by: r.created_by,
    })),
    config_diff: configRows.filter((c) => !same(c.values)),
    config_same: configRows.filter((c) => same(c.values)).map((c) => ({ key: c.key, value: c.values[0] })),
    metrics,
  };
}

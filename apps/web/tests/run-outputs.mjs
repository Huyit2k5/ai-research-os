// End-to-end checks for run output listing and downloads (auth, isolation, validation, MCP).
// Usage: RUNOUT_TEST_BASE=http://localhost:3004 node tests/doc-categories.mjs
// Optional RUNOUT_TEST_DB=<disposable postgres url> adds a Kaggle-sourced run (dummy token) to check error handling.
// Run only against a disposable database. Each run creates three runout-iso-* users and does not delete them.
// Better Auth rate-limits sign-up: wait ~10 s between runs.
import assert from "node:assert/strict";

const base = process.env.RUNOUT_TEST_BASE ?? "http://localhost:3004";
if (!/^http:\/\/localhost:\d+$/.test(base)) {
  throw new Error("Set RUNOUT_TEST_BASE=http://localhost:<port> (a local test server).");
}
const stamp = Date.now();
let passed = 0;
const ok = (name) => {
  passed++;
  console.log("  ✓", name);
};

async function request(path, { method = "GET", body, cookie, origin = base, bearer } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(origin ? { Origin: origin } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  const res = await fetch(base + path, {
    method,
    headers,
    redirect: "manual",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = res.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, body: data, cookie: cookies, text };
}
const merge = (cookie, fresh) => {
  if (!fresh) return cookie;
  const m = new Map();
  for (const part of `${cookie}; ${fresh}`.split("; ").filter(Boolean)) {
    const i = part.indexOf("=");
    m.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
};
const tool = async (bearer, name, args) => {
  const r = await request("/api/mcp", {
    method: "POST",
    bearer,
    origin: null,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const text = r.body?.result?.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: !!r.body?.result?.isError, text, data };
};
const users = Object.fromEntries(
  ["a", "b", "c"].map((k) => [
    k,
    {
      email: `runout-iso-${k}-${stamp}@example.test`,
      password: `runout-iso-password-${stamp}`,
      name: `RunOut ${k.toUpperCase()} ${stamp}`,
    },
  ]),
);
async function signUp(user) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: user });
  assert.equal(r.status, 200, `sign-up ${user.email}`);
  return r.cookie;
}
const workspaceOf = async (cookie) => (await request("/api/workspace", { cookie })).body;

console.log("Run output tests against", base);

// 1. Setup: A and B in separate workspaces
assert.equal((await request("/api/runs/1/outputs")).status, 401);
assert.equal((await request("/api/runs/1/outputs/file?name=x")).status, 401);
ok("anonymous list and download are rejected");
const a = await signUp(users.a);
const b = await signUp(users.b);
await workspaceOf(a);
await workspaceOf(b);
const manual = await request("/api/runs", { method: "POST", cookie: a, body: { name: `manual ${stamp}` } });
assert.equal(manual.status, 201, manual.text);
const runId = manual.body.id;

// 2. Validation and isolation
assert.equal((await request(`/api/runs/${runId}/outputs`, { cookie: a })).status, 422);
assert.equal((await request(`/api/runs/${runId}/outputs/file?name=x`, { cookie: a })).status, 422);
ok("a manual run has no Kaggle outputs (422)");
assert.equal((await request(`/api/runs/${runId}/outputs/file`, { cookie: a })).status, 422);
ok("a download without a file name is 422");
assert.equal((await request(`/api/runs/${runId}/outputs`, { cookie: b })).status, 404);
assert.equal((await request(`/api/runs/${runId}/outputs/file?name=x`, { cookie: b })).status, 404);
ok("another workspace cannot list or download");
assert.equal((await request("/api/runs/abc/outputs", { cookie: a })).status, 404);
assert.equal((await request("/api/runs/99999999999/outputs", { cookie: a })).status, 404);
ok("bad and huge run ids are 404");

// 3. A Kaggle run whose connection holds a dummy token: Kaggle refuses, the token never leaks
if (process.env.RUNOUT_TEST_DB) {
  const pg = (await import("pg")).default;
  const acc = await request("/api/accounts", {
    method: "POST",
    cookie: a,
    body: { label: `runout ${stamp}`, username: "runout", token: "dummy-kaggle-token-should-not-leak" },
  });
  assert.equal(acc.status, 201, acc.text);
  const client = new pg.Client({ connectionString: process.env.RUNOUT_TEST_DB });
  await client.connect();
  const kaggleRun = (
    await client.query(
      "INSERT INTO experiment_runs (owner_id, workspace_id, account_id, source, ref, version, name) SELECT owner_id, workspace_id, $1, 'kaggle', 'someone/nb', 2, 'kaggle run' FROM experiment_runs WHERE id=$2 RETURNING id",
      [acc.body.id, runId],
    )
  ).rows[0].id;
  await client.end();
  const r = await request(`/api/runs/${kaggleRun}/outputs`, { cookie: a });
  assert.equal(r.status, 502, r.text);
  assert.ok(!r.text.includes("dummy-kaggle-token"));
  const f = await request(`/api/runs/${kaggleRun}/outputs/file?name=x`, { cookie: a });
  assert.equal(f.status, 502);
  assert.ok(!f.text.includes("dummy-kaggle-token"));
  ok("a refused Kaggle token is a 502 that does not leak the token");
} else console.log("  - Kaggle error path skipped (set RUNOUT_TEST_DB)");

// 4. MCP
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "runout" } })).body.token;
const tools = await request("/api/mcp", {
  method: "POST",
  bearer: tA,
  origin: null,
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
});
const out = tools.body.result.tools.find((t) => t.name === "list_run_outputs");
assert.ok(out, "list_run_outputs is listed");
assert.equal(out.annotations.readOnlyHint, true);
const viaMcp = await tool(tA, "list_run_outputs", { run_id: runId });
assert.equal(viaMcp.isError, true);
ok("MCP lists list_run_outputs and refuses a manual run");

console.log(`\n${passed} checks passed.`);

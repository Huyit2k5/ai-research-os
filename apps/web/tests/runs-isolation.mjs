// End-to-end checks for experiment runs: ownership, compare, validation, CSRF and the MCP run tools.
// Usage: RUNS_TEST_BASE=http://localhost:3002 node tests/runs-isolation.mjs
// Run only against a disposable database. Each run creates two users named runs-iso-*@example.test and does not delete them.
// Kaggle capture is checked for ownership only (dummy credential, no Kaggle call is reached).
import assert from "node:assert/strict";

const base = process.env.RUNS_TEST_BASE ?? "http://localhost:3002";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("Set RUNS_TEST_BASE=http://localhost:<port> (a local test server).");
const stamp = Date.now();
let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };

async function request(path, { method = "GET", body, cookie, origin = base, bearer } = {}) {
  const headers = { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const cookies = res.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, cookie: cookies };
}
const mcp = (bearer, method, params, id = 1) => request("/api/mcp", { method: "POST", bearer, origin: null, body: { jsonrpc: "2.0", id, method, params } });
const tool = async (bearer, name, args) => { const r = await mcp(bearer, "tools/call", { name, arguments: args }); return { isError: !!r.body?.result?.isError, data: (() => { try { return JSON.parse(r.body?.result?.content?.[0]?.text ?? "null"); } catch { return r.body?.result?.content?.[0]?.text; } })() }; };
// MCP result shapes are tolerated loosely: a run may come back bare or wrapped as { run }, a list as { items } or a bare array.
const runId = (d) => d?.id ?? d?.run?.id;
const itemsOf = (d) => Array.isArray(d) ? d : d?.items ?? d?.runs ?? d?.accounts ?? [];

async function signUp(tag) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: { email: `runs-iso-${tag}-${stamp}@example.test`, password: `runs-iso-password-${stamp}`, name: `Runs Iso ${tag}` } });
  assert.equal(r.status, 200, `sign-up ${tag}`); assert.ok(r.cookie);
  return r.cookie;
}

console.log("Experiment run isolation tests against", base);

// 1. Auth
assert.equal((await request("/api/runs")).status, 401); ok("anonymous list is rejected");
assert.equal((await request("/api/runs", { method: "POST", body: { name: "anon" } })).status, 401); ok("anonymous create is rejected");

const a = await signUp("a"), b = await signUp("b");

// 2. A creates two manual runs
const history = [{ step: 1, train_loss: 0.9, val_acc: 0.6 }, { step: 2, train_loss: 0.5, val_acc: 0.75 }, { step: 3, train_loss: 0.35, val_acc: 0.87 }];
const run1 = { name: `iso run high-lr ${stamp}`, config: { lr: 0.001, batch_size: 32, optimizer: "adam" }, metrics: { val_acc: 0.87, train_loss: 0.35 }, history, notes: "run 1", tags: ["iso"], status: "complete", run_at: "2026-01-01T10:00:00Z", platform: "colab" };
const run2 = { name: `iso run low-lr ${stamp}`, config: { lr: 0.0003, batch_size: 32, optimizer: "adam" }, metrics: { val_acc: 0.81, train_loss: 0.29 }, history: history.slice(0, 2), notes: "run 2", tags: ["iso"], status: "complete", run_at: "2026-01-02T10:00:00Z", platform: "local" };
const c1 = await request("/api/runs", { method: "POST", cookie: a, body: run1 }), c2 = await request("/api/runs", { method: "POST", cookie: a, body: run2 });
assert.equal(c1.status, 201); assert.equal(c2.status, 201);
const r1 = c1.body.id, r2 = c2.body.id;
assert.equal(c1.body.source, "manual"); assert.equal(c1.body.config.lr, 0.001); assert.equal(c1.body.metrics.val_acc, 0.87); ok("A logs two manual runs");
const got1 = await request(`/api/runs/${r1}`, { cookie: a });
assert.equal(got1.status, 200); assert.equal(got1.body.history.length, 3); assert.equal(got1.body.history[2].val_acc, 0.87); assert.equal("code" in got1.body, false); ok("A reads own run with history, without code by default");
assert.equal("code" in (await request(`/api/runs/${r1}?code=1`, { cookie: a })).body, true); ok("?code=1 includes the code field");
const listA = await request("/api/runs", { cookie: a });
assert.equal(listA.status, 200); assert.equal(listA.body.total, 2); assert.equal(listA.body.items.length, 2); assert.ok(typeof listA.body.offset === "number" && typeof listA.body.limit === "number"); ok("A's list shows 2 runs");
assert.deepEqual((await request("/api/runs?sort=metric&metric=val_acc&order=desc", { cookie: a })).body.items.map(r => r.id), [r1, r2]); ok("sort by val_acc desc puts the higher run first");
assert.deepEqual((await request("/api/runs?sort=metric&metric=val_acc&order=asc", { cookie: a })).body.items.map(r => r.id), [r2, r1]); ok("sort by val_acc asc reverses the order");

// 3. B cannot see or touch A's runs
const listB = await request("/api/runs", { cookie: b });
assert.equal(listB.body.total, 0); assert.equal(listB.body.items.length, 0); ok("B's run list is empty");
assert.equal((await request(`/api/runs/${r1}`, { cookie: b })).status, 404); ok("B cannot read A's run");
assert.equal((await request(`/api/runs/${r1}?code=1`, { cookie: b })).status, 404); ok("B cannot read A's run code");
assert.equal((await request(`/api/runs/${r1}`, { method: "PATCH", cookie: b, body: { name: "hijack" } })).status, 404); ok("B cannot edit A's run");
assert.equal((await request(`/api/runs/${r1}`, { method: "DELETE", cookie: b })).status, 404); ok("B cannot delete A's run");
assert.equal((await request(`/api/runs/compare?ids=${r1},${r2}`, { cookie: b })).status, 404); ok("B cannot compare A's runs");
const accA = await request("/api/accounts", { method: "POST", cookie: a, body: { label: `runs-iso ${stamp}`, username: "runs-iso", token: "dummy-token" } });
assert.equal(accA.status, 201);
assert.equal((await request("/api/runs/capture", { method: "POST", cookie: b, body: { account_id: accA.body.id, ref: "runs-iso/notebook" } })).status, 404); ok("B cannot capture through A's Kaggle account");
assert.equal((await request("/api/runs/capture", { method: "POST", cookie: b, body: { account_id: 2147483647, ref: "runs-iso/notebook" } })).status, 404); ok("capture with an unknown account is 404");
assert.equal((await request(`/api/runs/${r1}`, { cookie: a })).body.name, run1.name); ok("A's run is intact after B's attempts");

// 4. Compare
const cmp = await request(`/api/runs/compare?ids=${r1},${r2}`, { cookie: a });
assert.equal(cmp.status, 200);
assert.deepEqual(cmp.body.runs.map(r => r.id), [r1, r2]);
assert.deepEqual(cmp.body.config_diff.map(c => c.key), ["lr"]); assert.deepEqual(cmp.body.config_diff[0].values, [0.001, 0.0003]); ok("config_diff contains only lr");
assert.deepEqual(cmp.body.config_same.map(c => c.key).sort(), ["batch_size", "optimizer"]); ok("shared config keys are in config_same");
const metric = (k) => cmp.body.metrics.find(m => m.key === k);
assert.equal(metric("val_acc").better, "higher"); assert.equal(metric("val_acc").best_index, 0); assert.deepEqual(metric("val_acc").values, [0.87, 0.81]); ok("val_acc: higher is better, best is run 1");
assert.equal(metric("train_loss").better, "lower"); assert.equal(metric("train_loss").best_index, 1); ok("train_loss: lower is better, best is run 2");

// 5. Validation
assert.equal((await request("/api/runs", { method: "POST", cookie: a, body: { config: { lr: 1 } } })).status, 422); ok("run without a name is rejected");
assert.equal((await request("/api/runs", { method: "POST", cookie: a, body: { name: "bad status", status: "finished" } })).status, 422); ok("invalid status is rejected");
const mixed = await request("/api/runs", { method: "POST", cookie: a, body: { name: `iso mixed metrics ${stamp}`, metrics: { val_acc: 0.5, comment: "great", f1: "0.7" } } });
assert.equal(mixed.status, 201); assert.equal("comment" in mixed.body.metrics, false); assert.equal(mixed.body.metrics.val_acc, 0.5); assert.equal(mixed.body.metrics.f1, 0.7); ok("non-numeric metric is dropped, numeric string is kept as a number");
assert.equal((await request(`/api/runs/compare?ids=${r1}`, { cookie: a })).status, 422); ok("compare with a single id is rejected");
assert.equal((await request(`/api/runs/compare?ids=${r1},${r1}`, { cookie: a })).status, 422); ok("compare with a duplicated id is rejected");
const paperB = await request("/api/papers", { method: "POST", cookie: b, body: { title: `Runs isolation paper B ${stamp}` } });
assert.equal(paperB.status, 201);
assert.equal((await request("/api/runs", { method: "POST", cookie: a, body: { name: "steal paper", paper_id: paperB.body.id } })).status, 422); ok("A cannot create a run linked to B's paper");
assert.equal((await request(`/api/runs/${r1}`, { method: "PATCH", cookie: a, body: { paper_id: paperB.body.id } })).status, 422); ok("A cannot link B's paper to own run");
const paperA = await request("/api/papers", { method: "POST", cookie: a, body: { title: `Runs isolation paper A ${stamp}` } });
assert.equal(paperA.status, 201);
assert.equal((await request(`/api/runs/${r1}`, { method: "PATCH", cookie: a, body: { paper_id: paperA.body.id } })).body.paper_id, paperA.body.id); ok("A can link own paper to own run");

// 6. CSRF
assert.equal((await request("/api/runs", { method: "POST", cookie: a, origin: "http://evil.example", body: { name: "csrf" } })).status, 403); ok("cross-origin create is rejected");
assert.equal((await request(`/api/runs/${r1}`, { method: "DELETE", cookie: a, origin: "http://evil.example" })).status, 403); ok("cross-origin delete is rejected");
assert.equal((await request(`/api/runs/${r1}`, { cookie: a })).status, 200); ok("A's run survives the cross-origin delete");

// 7. MCP
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "runs-iso" } })).body.token;
const tB = (await request("/api/tokens", { method: "POST", cookie: b, body: { name: "runs-iso" } })).body.token;
assert.ok(tA?.startsWith("ros_") && tB?.startsWith("ros_"));
const names = (await mcp(tA, "tools/list")).body.result.tools.map(t => t.name);
for (const n of ["list_runs", "get_run", "compare_runs", "log_run", "update_run", "delete_run", "capture_run", "list_compute_accounts"]) assert.ok(names.includes(n), n);
ok("MCP lists the run tools");
const logged = await tool(tA, "log_run", { name: `iso mcp run ${stamp}`, config: { lr: 0.01 }, metrics: { val_acc: 0.9 }, platform: "colab" });
assert.equal(logged.isError, false); const m1 = runId(logged.data); assert.ok(Number.isInteger(m1)); ok("A's token logs a run");
assert.ok(itemsOf((await tool(tA, "list_runs", {})).data).some(r => r.id === m1)); ok("A's list_runs sees the MCP run");
const gotM = await tool(tA, "get_run", { id: m1 });
assert.equal(gotM.isError, false); assert.equal(runId(gotM.data), m1); assert.equal((gotM.data.run ?? gotM.data).metrics.val_acc, 0.9); ok("A's get_run returns the run");
assert.equal((await tool(tB, "get_run", { id: m1 })).isError, true); ok("B's token cannot get_run A's run");
assert.equal((await tool(tB, "update_run", { id: m1, name: "hijack" })).isError, true); ok("B's token cannot update_run A's run");
assert.equal((await tool(tB, "delete_run", { id: m1 })).isError, true); ok("B's token cannot delete_run A's run");
assert.equal((await tool(tB, "compare_runs", { ids: [r1, m1] })).isError, true); ok("B's token cannot compare_runs A's runs");
assert.equal((await tool(tB, "capture_run", { account_id: accA.body.id, ref: "runs-iso/notebook" })).isError, true); ok("B's token cannot capture_run through A's account");
assert.equal(itemsOf((await tool(tB, "list_runs", {})).data).length, 0); ok("B's list_runs is empty");
const accountsB = (await tool(tB, "list_compute_accounts", {})).data;
assert.equal(itemsOf(accountsB).some(x => x.id === accA.body.id), false); ok("B's list_compute_accounts does not show A's account");
assert.equal(JSON.stringify(accountsB).includes("dummy-token"), false); assert.equal(JSON.stringify((await tool(tA, "list_compute_accounts", {})).data).includes("dummy-token"), false); ok("list_compute_accounts never returns credentials");
assert.equal((await tool(tA, "compare_runs", { ids: [r1, m1] })).isError, false); ok("A's token can compare own runs");
assert.equal((await tool(tA, "delete_run", { id: m1 })).isError, false);
assert.equal((await request(`/api/runs/${m1}`, { cookie: a })).status, 404); ok("A's delete_run removes the run");

// 8. Edit and delete a manual run
const patched = await request(`/api/runs/${r2}`, { method: "PATCH", cookie: a, body: { config: { lr: 0.0005, optimizer: { name: "sgd", momentum: 0.9 } }, metrics: { val_acc: 0.83 }, status: "error", notes: "edited", tags: ["iso", "edited"] } });
assert.equal(patched.status, 200); assert.equal(patched.body.config.lr, 0.0005); assert.equal(patched.body.config["optimizer.momentum"], 0.9); assert.equal(patched.body.metrics.val_acc, 0.83); assert.equal(patched.body.status, "error"); assert.equal(patched.body.notes, "edited"); ok("A can patch config, metrics and status of a manual run");
assert.equal((await request(`/api/runs/${r2}`, { method: "PATCH", cookie: a, body: { name: "" } })).status, 422); ok("blank name in PATCH is rejected");
assert.ok([200, 204].includes((await request(`/api/runs/${r2}`, { method: "DELETE", cookie: a })).status));
assert.equal((await request(`/api/runs/${r2}`, { cookie: a })).status, 404); ok("deleted run is gone");
assert.equal((await request(`/api/runs/compare?ids=${r1},${r2}`, { cookie: a })).status, 404); ok("compare with a deleted run is 404");

// Cleanup of the dummy Kaggle connection (users are kept, as in papers-isolation.mjs)
assert.equal((await request(`/api/accounts/${accA.body.id}`, { method: "DELETE", cookie: a })).status, 204);

console.log(`\n${passed} checks passed.`);

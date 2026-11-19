// End-to-end checks for run requests (AI proposes a Kaggle run, a member approves it on the web).
// Usage: RUNREQ_TEST_BASE=http://localhost:3004 [RUNREQ_TEST_DB=<disposable postgres url>] node tests/run-requests-isolation.mjs
// Run only against a disposable database. Connections use a dummy Kaggle token, so approve reaches Kaggle and fails there by design.
// Each run creates three runreq-iso-* users and does not delete them. Better Auth rate-limits sign-up: wait ~1 minute between runs.
import assert from "node:assert/strict";
import pg from "pg";

const base = process.env.RUNREQ_TEST_BASE ?? "http://localhost:3004";
if (!/^http:\/\/localhost:\d+$/.test(base))
  throw new Error("Set RUNREQ_TEST_BASE=http://localhost:<port> (a local test server).");
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
const mcp = (bearer, method, params, id = 1) =>
  request("/api/mcp", { method: "POST", bearer, origin: null, body: { jsonrpc: "2.0", id, method, params } });
const tool = async (bearer, name, args) => {
  const r = await mcp(bearer, "tools/call", { name, arguments: args });
  return {
    isError: !!r.body?.result?.isError,
    text: r.body?.result?.content?.[0]?.text ?? "",
    data: (() => {
      try {
        return JSON.parse(r.body?.result?.content?.[0]?.text ?? "null");
      } catch {
        return null;
      }
    })(),
  };
};
const users = Object.fromEntries(
  ["a", "b", "c"].map((k) => [
    k,
    {
      email: `runreq-iso-${k}-${stamp}@example.test`,
      password: `runreq-iso-password-${stamp}`,
      name: `RunReq ${k.toUpperCase()} ${stamp}`,
    },
  ]),
);
async function signUp(user) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: user });
  assert.equal(r.status, 200, `sign-up ${user.email}`);
  return r.cookie;
}
const workspaceOf = async (cookie) => {
  const r = await request("/api/workspace", { cookie });
  assert.equal(r.status, 200);
  return r.body;
};
async function setActive(cookie, organizationId) {
  const r = await request("/api/auth/organization/set-active", { method: "POST", cookie, body: { organizationId } });
  assert.equal(r.status, 200);
  return merge(cookie, r.cookie);
}

console.log("Run request isolation tests against", base);

// 1. Setup: A and B in separate workspaces, C joins A's workspace
assert.equal((await request("/api/run-requests")).status, 401);
ok("anonymous list is rejected");
assert.equal((await request("/api/run-requests", { method: "POST", body: { code: "x" } })).status, 401);
ok("anonymous create is rejected");
const a = await signUp(users.a),
  b = await signUp(users.b);
let c = await signUp(users.c);
const wsA = await workspaceOf(a);
await workspaceOf(b);
await workspaceOf(c);
const invite = await request("/api/auth/organization/invite-member", {
  method: "POST",
  cookie: a,
  body: { email: users.c.email, role: "member", organizationId: wsA.id },
});
assert.equal(invite.status, 200);
assert.equal(
  (
    await request("/api/auth/organization/accept-invitation", {
      method: "POST",
      cookie: c,
      body: { invitationId: invite.body.id },
    })
  ).status,
  200,
);
c = await setActive(c, wsA.id);

const accA = await request("/api/accounts", {
  method: "POST",
  cookie: a,
  body: { label: `runreq ${stamp}`, username: "runreq", token: "dummy-kaggle-token-should-not-leak" },
});
assert.equal(accA.status, 201);
const accountA = accA.body.id;
const accB = await request("/api/accounts", {
  method: "POST",
  cookie: b,
  body: { label: `runreq b ${stamp}`, username: "runreqb", token: "dummy-token-b" },
});
const accountB = accB.body.id;
const idea = (
  await request("/api/docs", {
    method: "POST",
    cookie: a,
    body: { kind: "idea", title: `Thử rank 16 ${stamp}`, format: "markdown", body: "x" },
  })
).body;
const report = (
  await request("/api/docs", {
    method: "POST",
    cookie: a,
    body: { kind: "report", title: `Báo cáo ${stamp}`, format: "markdown", body: "x" },
  })
).body;
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "runreq-iso" } })).body.token;
const tC = (await request("/api/tokens", { method: "POST", cookie: c, body: { name: "runreq-iso-c" } })).body.token;
let aCreated = 0,
  cCreated = 0;
const make = async (bearer, extra = {}) => {
  const r = await request("/api/run-requests", {
    method: "POST",
    bearer,
    origin: null,
    body: {
      account_id: accountA,
      ref: "runreq/lora-exp",
      kernel_type: "script",
      code: "print('hi')",
      summary: "Tăng rank",
      machine: "cpu",
      ...extra,
    },
  });
  if (r.status === 201) {
    if (bearer === tC) cCreated++;
    else aCreated++;
  }
  return r;
};

// 2. Create via token
const r1 = await make(tA, { idea_id: idea.id });
assert.equal(r1.status, 201, r1.text);
assert.equal(r1.body.status, "pending");
assert.equal(r1.body.requested_via, "api");
assert.equal(r1.body.idea_id, idea.id);
assert.equal(r1.body.idea_title, idea.title);
assert.equal(r1.body.code, undefined);
assert.equal(r1.body.settings.machine, "cpu");
assert.equal(r1.body.mine, true);
assert.equal(r1.body.can_cancel, true);
ok("a token creates a pending request (via api, idea linked, no code in the answer)");
const req1 = r1.body.id;
const full = await request(`/api/run-requests/${req1}?code=1`, { cookie: c });
assert.equal(full.status, 200);
assert.equal(full.body.code, "print('hi')");
assert.equal(full.body.mine, false);
assert.equal(full.body.can_cancel, false);
ok("a workspace member reads it with ?code=1");
assert.ok(!full.text.includes("dummy-kaggle-token"));
ok("the Kaggle token never appears in the answer");
assert.equal((await request(`/api/run-requests/${req1}`, { cookie: b })).status, 404);
ok("another workspace gets 404");
assert.ok(!(await request("/api/run-requests", { cookie: b })).body.items.some((r) => r.id === req1));
ok("another workspace's list does not contain it");
const listA = (await request(`/api/run-requests?status=pending&idea_id=${idea.id}`, { cookie: a })).body;
assert.ok(listA.items.some((r) => r.id === req1));
assert.ok(listA.pending >= 1);
assert.equal(listA.items[0].code, undefined);
ok("list filters by status and idea, reports the pending count");

// 3. Validation
const bad = async (extra, what) => {
  const r = await make(tA, extra);
  assert.equal(r.status, 422, `${what}: ${r.status} ${r.text}`);
  ok(`422: ${what}`);
};
await bad({ account_id: accountB }, "connection of another workspace");
await bad({ idea_id: report.id }, "idea_id that is not an idea");
await bad({ machine: "a100" }, "unknown machine");
await bad({ kernel_type: "notebook", code: "print(1)" }, "bad ipynb");
await bad({ code: "x".repeat(2 * 1024 * 1024 + 1) }, "code over 2 MB");
await bad({ ref: undefined }, "neither ref nor new_title");
await bad({ ref: "someoneelse/nb" }, "ref owned by another Kaggle user");
await bad({ summary: "s".repeat(4001) }, "summary over 4000");
const fresh = await make(tA, {
  ref: undefined,
  new_title: "Notebook mới",
  kernel_type: "notebook",
  code: JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
});
assert.equal(fresh.status, 201, fresh.text);
assert.equal(fresh.body.ref, null);
assert.equal(fresh.body.new_title, "Notebook mới");
ok("a new notebook request (new_title, ipynb) is accepted");
const saveOnlyReq = await make(tA, { run: false, timeout_minutes: 30 });
assert.equal(saveOnlyReq.status, 201, saveOnlyReq.text);
assert.equal(saveOnlyReq.body.settings.run, false);
assert.equal(saveOnlyReq.body.settings.timeout_minutes, 30);
ok("run: false and timeout_minutes are kept on the request");
await bad({ timeout_minutes: 0 }, "timeout_minutes 0");
await bad({ timeout_minutes: 721 }, "timeout_minutes over 720");
await bad({ run: "no" }, "non-boolean run");

// 4. Reject and cancel
const viaToken = await request(`/api/run-requests/${req1}/reject`, {
  method: "POST",
  bearer: tA,
  origin: null,
  body: { note: "x" },
});
assert.equal(viaToken.status, 401);
ok("a token cannot reject");
const rej = await request(`/api/run-requests/${req1}/reject`, {
  method: "POST",
  cookie: c,
  body: { note: "Thêm warmup trước" },
});
assert.equal(rej.status, 200, rej.text);
assert.equal(rej.body.status, "rejected");
assert.equal(rej.body.review_note, "Thêm warmup trước");
assert.equal(rej.body.reviewed_by_name, users.c.name);
ok("a member rejects with a note");
assert.equal(
  (await request(`/api/run-requests/${req1}/reject`, { method: "POST", cookie: a, body: { note: "again" } })).status,
  409,
);
ok("rejecting twice is 409");
assert.equal(
  (
    await request(`/api/run-requests/${req1}/reject`, {
      method: "POST",
      cookie: a,
      origin: "https://evil.example",
      body: { note: "x" },
    })
  ).status,
  403,
);
ok("cross-origin reject is rejected");
const toCancel = (await make(tA)).body.id;
assert.equal((await request(`/api/run-requests/${toCancel}/cancel`, { method: "POST", cookie: c })).status, 403);
ok("a member cannot cancel another member's request");
assert.equal((await request(`/api/run-requests/${toCancel}/cancel`, { method: "POST", cookie: b })).status, 404);
ok("another workspace cannot cancel");
const cancelled = await request(`/api/run-requests/${toCancel}/cancel`, { method: "POST", bearer: tA, origin: null });
assert.equal(cancelled.status, 200);
assert.equal(cancelled.body.status, "cancelled");
ok("the requester cancels with their token");
const cByC = (await make(tC)).body.id;
assert.equal((await request(`/api/run-requests/${cByC}/cancel`, { method: "POST", cookie: a })).status, 200);
ok("the workspace owner cancels a member's request");

// 5. Idea deleted
const idea2 = (
  await request("/api/docs", {
    method: "POST",
    cookie: a,
    body: { kind: "idea", title: `Tạm ${stamp}`, format: "markdown", body: "x" },
  })
).body;
const withIdea2 = (await make(tA, { idea_id: idea2.id })).body.id;
assert.equal((await request(`/api/docs/${idea2.id}`, { method: "DELETE", cookie: a })).status, 204);
const afterDelete = await request(`/api/run-requests/${withIdea2}`, { cookie: a });
assert.equal(afterDelete.status, 200);
assert.equal(afterDelete.body.idea_id, null);
ok("idea deleted: the request stays, idea_id null");

// 6. Expiry (needs direct access to the disposable database)
if (process.env.RUNREQ_TEST_DB) {
  const old = (await make(tA)).body.id;
  const client = new pg.Client({ connectionString: process.env.RUNREQ_TEST_DB });
  await client.connect();
  await client.query("UPDATE run_requests SET created_at=now()-interval '8 days' WHERE id=$1", [old]);
  await client.end();
  assert.ok((await request("/api/run-requests?status=expired", { cookie: a })).body.items.some((r) => r.id === old));
  ok("a pending request older than 7 days becomes expired");
} else console.log("  - expiry skipped (set RUNREQ_TEST_DB)");

// 7. Approve and run-now (the dummy Kaggle token makes every push fail at Kaggle, after all checks)
const toApprove = (await make(tA, { idea_id: idea.id })).body.id;
assert.equal(
  (await request(`/api/run-requests/${toApprove}/approve`, { method: "POST", bearer: tA, origin: null })).status,
  401,
);
ok("a token cannot approve");
assert.equal(
  (
    await request("/api/run-requests/run-now", {
      method: "POST",
      bearer: tA,
      origin: null,
      body: { account_id: accountA, ref: "runreq/lora-exp" },
    })
  ).status,
  401,
);
ok("a token cannot run-now");
assert.equal((await request(`/api/run-requests/${toApprove}`, { cookie: a })).body.status, "pending");
ok("the request is still pending after token attempts");
assert.equal(
  (
    await request(`/api/run-requests/${toApprove}/approve`, {
      method: "POST",
      cookie: a,
      origin: "https://evil.example",
    })
  ).status,
  403,
);
ok("cross-origin approve is rejected");
assert.equal((await request(`/api/run-requests/${toApprove}/approve`, { method: "POST", cookie: b })).status, 404);
ok("another workspace cannot approve");
const tried = await request(`/api/run-requests/${toApprove}/approve`, { method: "POST", cookie: a });
assert.equal(tried.status, 502, tried.text);
assert.ok(!tried.text.includes("dummy-kaggle-token"));
ok("approve reaches Kaggle (502 with the dummy token) and does not leak the token");
const afterTry = (await request(`/api/run-requests/${toApprove}`, { cookie: a })).body;
assert.equal(afterTry.status, "pending");
assert.ok(afterTry.error && afterTry.error.length > 0);
assert.equal(afterTry.version, null);
ok("a failed push returns the request to pending with the error");
assert.equal((await request(`/api/docs/${idea.id}`, { cookie: a })).body.status, "new");
ok("a failed push leaves the idea status alone");
const race = (await make(tA)).body.id;
const both = await Promise.all([
  request(`/api/run-requests/${race}/approve`, { method: "POST", cookie: a }),
  request(`/api/run-requests/${race}/approve`, { method: "POST", cookie: c }),
]);
assert.deepEqual(both.map((r) => r.status).sort(), [409, 502], both.map((r) => r.text).join(" | "));
ok("two reviewers approving at once: one push, one 409");
assert.equal((await request(`/api/run-requests/${req1}/approve`, { method: "POST", cookie: a })).status, 409);
ok("a rejected request cannot be approved");
const toSave = (await make(tA)).body.id;
assert.equal(
  (await request(`/api/run-requests/${toSave}/approve`, { method: "POST", bearer: tA, origin: null, body: { save_only: true } }))
    .status,
  401,
);
ok("a token cannot approve a Quick Save either");
const saveTry = await request(`/api/run-requests/${toSave}/approve`, {
  method: "POST",
  cookie: a,
  body: { save_only: true },
});
assert.equal(saveTry.status, 502, saveTry.text);
const afterSave = (await request(`/api/run-requests/${toSave}`, { cookie: a })).body;
assert.equal(afterSave.status, "pending");
assert.equal(afterSave.settings.run, undefined);
ok("a failed Quick Save leaves the request pending and does not keep the save-only choice");
assert.equal((await request("/api/run-requests?status=saved", { cookie: a })).status, 200);
ok("saved is a known status for filtering");
const manual = await request("/api/runs", { method: "POST", cookie: a, body: { name: `manual ${stamp}` } });
assert.equal(manual.status, 201, manual.text);
const noCode = await request("/api/run-requests/run-now", {
  method: "POST",
  cookie: a,
  body: { run_id: manual.body.id },
});
assert.equal(noCode.status, 422, noCode.text);
ok("run-now of a run without stored code is 422");
const now = await request("/api/run-requests/run-now", {
  method: "POST",
  cookie: a,
  body: { account_id: accountA, ref: "runreq/lora-exp", machine: "cpu" },
});
assert.equal(now.status, 502, now.text);
ok("run-now reaches Kaggle (502 with the dummy token)");
const nowRow = (await request("/api/run-requests?limit=1", { cookie: a })).body.items[0];
assert.equal(nowRow.requested_via, "web");
assert.equal(nowRow.status, "pending");
assert.ok(nowRow.error);
ok("run-now records a web request that stays pending with the error");
// C used 1 approve in the race above; 9 more reach 10 in the minute, the next one is refused.
for (let i = 0; i < 9; i++)
  assert.equal((await request(`/api/run-requests/${req1}/approve`, { method: "POST", cookie: c })).status, 409);
const limited = await request(`/api/run-requests/${req1}/approve`, { method: "POST", cookie: c });
assert.equal(limited.status, 429, limited.text);
ok("approve is rate-limited to 10 per minute per user");

// 8. Status and diff base
const st = await request(`/api/run-requests/${toApprove}/status`, { bearer: tA, origin: null });
assert.equal(st.status, 200, st.text);
assert.equal(st.body.status, "pending");
ok("status of a pending request answers without calling Kaggle");
assert.equal((await request(`/api/run-requests/${toApprove}/status`, { cookie: b })).status, 404);
ok("another workspace cannot read the status");
const baseNew = await request(`/api/run-requests/${fresh.body.id}/base`, { cookie: a });
assert.equal(baseNew.status, 200);
assert.equal(baseNew.body.code, null);
ok("diff base of a new notebook is null (no Kaggle call)");
const baseRef = await request(`/api/run-requests/${toApprove}/base`, { bearer: tA, origin: null });
assert.equal(baseRef.status, 502, baseRef.text);
assert.ok(!baseRef.text.includes("dummy-kaggle-token"));
ok("diff base of an existing notebook asks Kaggle (502 with the dummy token, no leak)");
assert.equal((await request(`/api/run-requests/${toApprove}/base`, { cookie: b })).status, 404);
ok("another workspace cannot read the diff base");
if (process.env.RUNREQ_TEST_DB) {
  const client = new pg.Client({ connectionString: process.env.RUNREQ_TEST_DB });
  await client.connect();
  await client.query("UPDATE run_requests SET status='running', version=3 WHERE id=$1", [toApprove]);
  const live = await request(`/api/run-requests/${toApprove}/status`, { cookie: a });
  assert.equal(live.status, 502, live.text);
  ok("status of a running request asks Kaggle");
  assert.equal(
    (await client.query("SELECT status FROM run_requests WHERE id=$1", [toApprove])).rows[0].status,
    "running",
  );
  ok("a Kaggle error while following leaves the request running");
  await client.query("UPDATE run_requests SET status='pending', version=NULL WHERE id=$1", [toApprove]);
  await client.end();
} else console.log("  - running status skipped (set RUNREQ_TEST_DB)");

// 8b. MCP tools
const names = (await mcp(tA, "tools/list", {})).body.result.tools.map((t) => t.name);
for (const n of ["push_notebook", "list_run_requests", "get_run_request", "cancel_run_request"])
  assert.ok(names.includes(n), n);
assert.ok(!names.some((n) => /approve|reject|run_now/.test(n)));
ok("MCP lists the 4 run-request tools and no approve/reject tool");
const pushed = await tool(tA, "push_notebook", {
  account_id: accountA,
  ref: "runreq/lora-exp",
  kernel_type: "script",
  code: "print('mcp')",
  machine: "cpu",
  summary: "Qua MCP",
  idea_id: idea.id,
});
assert.equal(pushed.isError, false, pushed.text);
assert.equal(pushed.data.status, "pending");
assert.match(pushed.data.review_url, new RegExp(`/run-requests/${pushed.data.id}$`));
aCreated++;
assert.equal((await request(`/api/run-requests/${pushed.data.id}`, { cookie: a })).body.requested_via, "mcp");
ok("push_notebook creates a pending request via mcp with a review link");
await request(`/api/run-requests/${pushed.data.id}/reject`, { method: "POST", cookie: c, body: { note: "Đổi lr" } });
const got = await tool(tA, "get_run_request", { id: pushed.data.id });
assert.equal(got.data.status, "rejected");
assert.equal(got.data.review_note, "Đổi lr");
assert.equal(got.data.code, "print('mcp')");
ok("get_run_request shows the reviewer's note and the code");
const listed = await tool(tA, "list_run_requests", { status: "rejected", idea_id: idea.id });
assert.ok(listed.data.items.some((r) => r.id === pushed.data.id));
ok("list_run_requests filters by status and idea");
const cOwn = await tool(tC, "push_notebook", {
  account_id: accountA,
  ref: "runreq/lora-exp",
  kernel_type: "script",
  code: "print(2)",
});
cCreated++;
assert.equal((await tool(tC, "cancel_run_request", { id: (await make(tA)).body.id })).isError, true);
ok("cancel_run_request refuses another member's request");
assert.equal((await tool(tC, "cancel_run_request", { id: cOwn.data.id })).data.status, "cancelled");
ok("cancel_run_request cancels your own request");
assert.equal(
  (await tool(tA, "push_notebook", { account_id: accountA, ref: "runreq/lora-exp", code: "x", machine: "a100" }))
    .isError,
  true,
);
ok("push_notebook surfaces validation errors");

// 9. Pending cap (keep last: it fills the workspace with 50 pending requests)
const pendingNow = (await request("/api/run-requests?status=pending&limit=1", { cookie: a })).body.pending;
for (let n = pendingNow; n < 50; n++) {
  const r = aCreated < 30 ? await make(tA) : await make(tC);
  assert.equal(r.status, 201, `fill ${n}: ${r.text}`);
}
const over = await make(cCreated < 30 ? tC : tA);
assert.equal(over.status, 429, over.text);
assert.match(over.body.detail, /50/);
ok("the 51st pending request in a workspace is refused");

console.log(`\n${passed} checks passed`);

// End-to-end checks for notebook categories (starter set, labels, isolation, MCP).
// Usage: NBCAT_TEST_BASE=http://localhost:3004 node tests/doc-categories.mjs
// Run only against a disposable database. Each run creates three nbcat-iso-* users and does not delete them.
// Better Auth rate-limits sign-up: wait ~10 s between runs.
import assert from "node:assert/strict";

const base = process.env.NBCAT_TEST_BASE ?? "http://localhost:3004";
if (!/^http:\/\/localhost:\d+$/.test(base)) {
  throw new Error("Set NBCAT_TEST_BASE=http://localhost:<port> (a local test server).");
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
      email: `nbcat-iso-${k}-${stamp}@example.test`,
      password: `nbcat-iso-password-${stamp}`,
      name: `NbCat ${k.toUpperCase()} ${stamp}`,
    },
  ]),
);
async function signUp(user) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: user });
  assert.equal(r.status, 200, `sign-up ${user.email}`);
  return r.cookie;
}
const workspaceOf = async (cookie) => (await request("/api/workspace", { cookie })).body;
const list = async (cookie) => {
  const r = await request("/api/notebook-categories", { cookie });
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const label = (cookie, body, origin) =>
  request("/api/notebook-categories/labels", { method: "PUT", cookie, body, ...(origin ? { origin } : {}) });

console.log("Notebook category tests against", base);

// 1. Setup: A and B in separate workspaces, C joins A's workspace as a member
assert.equal((await request("/api/notebook-categories")).status, 401);
ok("anonymous list is rejected");
const a = await signUp(users.a);
const b = await signUp(users.b);
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
const accepted = await request("/api/auth/organization/accept-invitation", {
  method: "POST",
  cookie: c,
  body: { invitationId: invite.body.id },
});
assert.equal(accepted.status, 200);
const active = await request("/api/auth/organization/set-active", {
  method: "POST",
  cookie: c,
  body: { organizationId: wsA.id },
});
c = merge(c, active.cookie);
const account = async (cookie, name) => {
  const r = await request("/api/accounts", {
    method: "POST",
    cookie,
    body: { label: `nbcat ${name} ${stamp}`, username: `nbcat${name}`, token: "dummy-kaggle-token" },
  });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
};
const accA = await account(a, "a"),
  accB = await account(b, "b");

// 2. Starter categories, created once per workspace
const first = await list(a);
const names = (cats) => cats.map((x) => x.name).sort();
assert.deepEqual(names(first.categories), ["Huấn luyện", "Đánh giá"].sort());
assert.deepEqual(first.labels, []);
assert.equal((await list(a)).categories.length, 2);
ok("a workspace starts with Huấn luyện and Đánh giá, once");
for (const x of first.categories) {
  assert.equal((await request(`/api/notebook-categories/${x.id}`, { method: "DELETE", cookie: a })).status, 204);
}
assert.deepEqual((await list(a)).categories, []);
ok("deleted starter categories do not come back");

// 3. Create, rename, delete rights
const create = (cookie, name) => request("/api/notebook-categories", { method: "POST", cookie, body: { name } });
const train = await create(a, "Huấn luyện");
assert.equal(train.status, 201, train.text);
assert.equal((await create(a, "  huấn   LUYỆN ")).status, 409);
assert.equal((await create(a, "   ")).status, 422);
assert.equal((await create(a, "x".repeat(61))).status, 422);
ok("duplicate (ignoring case and spaces), empty and too-long names are rejected");
const evalCat = await create(c, "Đánh giá");
assert.equal(evalCat.status, 201);
const renamed = await request(`/api/notebook-categories/${train.body.id}`, {
  method: "PATCH",
  cookie: c,
  body: { name: "Train" },
});
assert.equal(renamed.status, 200);
assert.equal(renamed.body.name, "Train");
assert.equal((await request(`/api/notebook-categories/${train.body.id}`, { method: "DELETE", cookie: c })).status, 403);
ok("a member renames any category but deletes only their own");
assert.equal(
  (await request(`/api/notebook-categories/${train.body.id}`, { method: "PATCH", cookie: b, body: { name: "y" } }))
    .status,
  404,
);
ok("another workspace cannot rename it");

// 4. Labels
const ref = "someone/vit-cifar10";
const set1 = await label(c, { account_id: accA, ref, category_id: train.body.id });
assert.equal(set1.status, 200, set1.text);
let now = await list(a);
assert.deepEqual(now.labels, [{ account_id: accA, ref, category_id: train.body.id }]);
assert.equal(now.categories.find((x) => x.id === train.body.id).notebook_count, 1);
ok("any member labels a notebook and the count follows");
assert.equal((await label(a, { account_id: accA, ref, category_id: evalCat.body.id })).status, 200);
now = await list(a);
assert.equal(now.labels.length, 1);
assert.equal(now.labels[0].category_id, evalCat.body.id);
ok("relabelling replaces the label");
assert.equal((await label(a, { account_id: accA, ref: "no slash", category_id: train.body.id })).status, 422);
assert.equal((await label(a, { account_id: accB, ref, category_id: train.body.id })).status, 404);
const bCat = (await create(b, "B only")).body;
assert.equal((await label(a, { account_id: accA, ref, category_id: bCat.id })).status, 422);
assert.equal((await label(a, { account_id: accA, ref, category_id: train.body.id }, "http://evil.test")).status, 403);
ok("bad ref, foreign account, foreign category and cross-site requests are rejected");
const bView = await list(b);
assert.deepEqual(names(bView.categories), ["B only", "Huấn luyện", "Đánh giá"].sort());
assert.deepEqual(bView.labels, []);
ok("another workspace sees only its own categories and labels");
assert.equal((await label(a, { account_id: accA, ref, category_id: null })).status, 200);
assert.deepEqual((await list(a)).labels, []);
ok("category_id null clears the label");
await label(a, { account_id: accA, ref, category_id: evalCat.body.id });
assert.equal(
  (await request(`/api/notebook-categories/${evalCat.body.id}`, { method: "DELETE", cookie: a })).status,
  204,
);
assert.deepEqual((await list(a)).labels, []);
ok("deleting a category leaves its notebooks uncategorized");

// 5. MCP
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "nbcat" } })).body.token;
const tools = await request("/api/mcp", {
  method: "POST",
  bearer: tA,
  origin: null,
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
});
const toolNames = tools.body.result.tools.map((t) => t.name);
assert.ok(toolNames.includes("list_notebook_categories") && toolNames.includes("set_notebook_category"));
const viaMcp = await tool(tA, "set_notebook_category", { account_id: accA, ref, category_id: train.body.id });
assert.equal(viaMcp.isError, false, viaMcp.text);
const listed = await tool(tA, "list_notebook_categories", {});
assert.deepEqual(listed.data.labels, [{ account_id: accA, ref, category_id: train.body.id }]);
assert.ok(listed.data.categories.some((x) => x.name === "Train"));
const bad = await tool(tA, "set_notebook_category", { account_id: accB, ref, category_id: train.body.id });
assert.equal(bad.isError, true);
ok("MCP lists categories and labels a notebook, scoped to the token's workspace");

console.log(`\n${passed} checks passed.`);

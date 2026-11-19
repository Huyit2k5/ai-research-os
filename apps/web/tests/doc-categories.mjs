// End-to-end checks for document categories and result documents.
// Usage: DOCCAT_TEST_BASE=http://localhost:3004 node tests/doc-categories.mjs
// Run only against a disposable database. Each run creates three doccat-iso-* users and does not delete them.
// Better Auth rate-limits sign-up: wait ~10 s between runs.
import assert from "node:assert/strict";

const base = process.env.DOCCAT_TEST_BASE ?? "http://localhost:3004";
if (!/^http:\/\/localhost:\d+$/.test(base)) {
  throw new Error("Set DOCCAT_TEST_BASE=http://localhost:<port> (a local test server).");
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
      email: `doccat-iso-${k}-${stamp}@example.test`,
      password: `doccat-iso-password-${stamp}`,
      name: `DocCat ${k.toUpperCase()} ${stamp}`,
    },
  ]),
);
async function signUp(user) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: user });
  assert.equal(r.status, 200, `sign-up ${user.email}`);
  return r.cookie;
}
const workspaceOf = async (cookie) => (await request("/api/workspace", { cookie })).body;

console.log("Document category tests against", base);

// 1. Setup
assert.equal((await request("/api/docs/categories")).status, 401);
ok("anonymous category list is rejected");
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
const active = await request("/api/auth/organization/set-active", {
  method: "POST",
  cookie: c,
  body: { organizationId: wsA.id },
});
c = merge(c, active.cookie);
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "doccat" } })).body.token;
const runIds = [];
for (let i = 0; i < 11; i++) {
  const r = await request("/api/runs", {
    method: "POST",
    cookie: a,
    body: { name: `run ${i} ${stamp}`, metrics: { val_loss: 1 - i / 20 } },
  });
  assert.equal(r.status, 201, r.text);
  runIds.push(r.body.id);
}

// 2. Categories
const lora = await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "LoRA" } });
assert.equal(lora.status, 201, lora.text);
assert.equal(lora.body.name, "LoRA");
assert.equal(lora.body.doc_count, 0);
ok("a member creates a category");
assert.equal(
  (await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "lora" } })).status,
  409,
);
ok("duplicate name ignoring case is 409");
assert.equal((await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "  " } })).status, 422);
assert.equal(
  (await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "x".repeat(61) } })).status,
  422,
);
ok("empty or 61-character names are 422");
const bCat = await request("/api/docs/categories", { method: "POST", cookie: b, body: { name: "B only" } });
assert.equal(bCat.status, 201);
assert.ok(!(await request("/api/docs/categories", { cookie: b })).body.some((x) => x.id === lora.body.id));
assert.equal(
  (await request(`/api/docs/categories/${lora.body.id}`, { method: "PATCH", cookie: b, body: { name: "x" } })).status,
  404,
);
assert.equal((await request(`/api/docs/categories/${lora.body.id}`, { method: "DELETE", cookie: b })).status, 404);
ok("another workspace cannot see, rename or delete it");

const doc = await request("/api/docs", {
  method: "POST",
  cookie: a,
  body: { kind: "report", title: `Báo cáo ${stamp}`, format: "markdown", body: "x", category_id: lora.body.id },
});
assert.equal(doc.status, 201, doc.text);
assert.equal(doc.body.category_id, lora.body.id);
assert.equal(doc.body.category_name, "LoRA");
ok("a doc is created in a category");
assert.ok(
  (await request(`/api/docs?category=${lora.body.id}`, { cookie: a })).body.items.some((d) => d.id === doc.body.id),
);
assert.ok(!(await request("/api/docs?category=none", { cookie: a })).body.items.some((d) => d.id === doc.body.id));
ok("list filters by category and by none");
assert.equal(
  (
    await request("/api/docs", {
      method: "POST",
      cookie: a,
      body: { kind: "other", title: "x", format: "markdown", body: "x", category_id: bCat.body.id },
    })
  ).status,
  422,
);
assert.equal(
  (await request(`/api/docs/${doc.body.id}`, { method: "PATCH", cookie: a, body: { category_id: bCat.body.id } }))
    .status,
  422,
);
ok("foreign category id is 422 on create and update");
assert.equal((await request(`/api/docs?category=${bCat.body.id}`, { cookie: a })).body.items.length, 0);
ok("filtering by a foreign category returns nothing");
assert.equal(
  (await request("/api/docs/categories", { cookie: a })).body.find((x) => x.id === lora.body.id).doc_count,
  1,
);
ok("category lists carry doc counts");

const renamed = await request(`/api/docs/categories/${lora.body.id}`, {
  method: "PATCH",
  cookie: c,
  body: { name: "LoRA 2" },
});
assert.equal(renamed.status, 200, renamed.text);
assert.equal((await request(`/api/docs/${doc.body.id}`, { cookie: a })).body.category_name, "LoRA 2");
ok("a member renames it and docs show the new name");
const other = (await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "Tuần 47" } })).body;
assert.equal(
  (await request(`/api/docs/categories/${lora.body.id}`, { method: "PATCH", cookie: a, body: { name: "tuần 47" } }))
    .status,
  409,
);
ok("renaming onto an existing name is 409");
assert.equal((await request(`/api/docs/categories/${lora.body.id}`, { method: "DELETE", cookie: c })).status, 403);
ok("a member cannot delete another member's category");
assert.equal((await request(`/api/docs/categories/${lora.body.id}`, { method: "DELETE", cookie: a })).status, 204);
const afterDelete = (await request(`/api/docs/${doc.body.id}`, { cookie: a })).body;
assert.equal(afterDelete.category_id, null);
ok("deleting a category keeps its docs, uncategorized");
assert.equal(
  (await request(`/api/docs/${doc.body.id}`, { method: "PATCH", cookie: a, body: { category_id: other.id } })).body
    .category_id,
  other.id,
);
assert.equal(
  (await request(`/api/docs/${doc.body.id}`, { method: "PATCH", cookie: a, body: { category_id: null } })).body
    .category_id,
  null,
);
ok("category_id can be set and cleared");

// 3. Result documents
const result = await request("/api/docs", {
  method: "POST",
  cookie: a,
  body: {
    kind: "result",
    title: `Kết quả ${stamp}`,
    format: "markdown",
    body: "Kết luận",
    run_ids: runIds.slice(0, 2),
  },
});
assert.equal(result.status, 201, result.text);
assert.equal(result.body.kind, "result");
assert.equal(result.body.run_count, 2);
assert.equal(result.body.status, null);
ok("a result doc links runs");
assert.equal(
  (
    await request("/api/docs", {
      method: "POST",
      cookie: a,
      body: { kind: "result", title: "x", format: "markdown", body: "", run_ids: runIds },
    })
  ).status,
  422,
);
ok("a result doc with 11 runs is 422");
assert.equal(
  (
    await request("/api/docs", {
      method: "POST",
      cookie: a,
      body: { kind: "result", title: "x", format: "markdown", body: "", status: "new" },
    })
  ).status,
  422,
);
ok("a result doc has no status");
const wide = await request("/api/docs", {
  method: "POST",
  cookie: a,
  body: { kind: "report", title: "11 runs", format: "markdown", body: "", run_ids: runIds },
});
assert.equal(wide.status, 201, wide.text);
assert.equal(
  (await request(`/api/docs/${wide.body.id}`, { method: "PATCH", cookie: a, body: { kind: "result" } })).status,
  422,
);
assert.equal((await request(`/api/docs/${wide.body.id}`, { cookie: a })).body.kind, "report");
ok("changing a doc with 11 runs to result is 422 and changes nothing");
const upload = await request("/api/docs/uploads", {
  method: "POST",
  cookie: a,
  body: { kind: "result", file_name: "r.pdf", content_type: "application/pdf", size: 10 },
});
assert.ok([422, 503].includes(upload.status), upload.text);
ok(`a result upload is refused (${upload.status})`);
assert.ok((await request("/api/docs?kind=result", { cookie: a })).body.items.some((d) => d.id === result.body.id));
ok("list filters by kind=result");

// 4. Limit (keep last: fills the workspace with categories)
const have = (await request("/api/docs/categories", { cookie: a })).body.length;
for (let i = have; i < 50; i++) {
  const r = await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: `cat ${i} ${stamp}` } });
  assert.equal(r.status, 201, r.text);
}
const over = await request("/api/docs/categories", { method: "POST", cookie: a, body: { name: "one too many" } });
assert.equal(over.status, 422, over.text);
assert.match(over.body.detail, /50/);
ok("the 51st category is refused");

console.log(`\n${passed} checks passed`);

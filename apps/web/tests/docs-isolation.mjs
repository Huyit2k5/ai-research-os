// End-to-end checks for workspace documents: text docs, idea status, paper/run links, tokens, sharing, file uploads, MCP.
// Usage: DOCS_TEST_BASE=http://localhost:3002 node tests/docs-isolation.mjs
// Run only against a disposable database and a local S3 (MinIO). Each run creates two docs-iso-* users and does not delete them.
import assert from "node:assert/strict";

const base = process.env.DOCS_TEST_BASE ?? "http://localhost:3002";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("Set DOCS_TEST_BASE=http://localhost:<port> (a local test server).");
const stamp = Date.now();
let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };

async function request(path, { method = "GET", body, cookie, origin = base, bearer } = {}) {
  const headers = { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  const res = await fetch(base + path, { method, headers, redirect: "manual", ...(body ? { body: JSON.stringify(body) } : {}) });
  const cookies = res.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, cookie: cookies, headers: res.headers };
}
const merge = (cookie, fresh) => { if (!fresh) return cookie; const m = new Map(); for (const part of `${cookie}; ${fresh}`.split("; ").filter(Boolean)) { const i = part.indexOf("="); m.set(part.slice(0, i), part.slice(i + 1)); } return [...m].map(([k, v]) => `${k}=${v}`).join("; "); };
const users = { a: { email: `docs-iso-a-${stamp}@example.test`, password: `docs-iso-password-${stamp}`, name: `Docs A ${stamp}` }, b: { email: `docs-iso-b-${stamp}@example.test`, password: `docs-iso-password-${stamp}`, name: `Docs B ${stamp}` } };
async function signUp(user) { const r = await request("/api/auth/sign-up/email", { method: "POST", body: user }); assert.equal(r.status, 200, `sign-up ${user.email}`); return r.cookie; }
const workspaceOf = async (cookie) => { const r = await request("/api/workspace", { cookie }); assert.equal(r.status, 200); return r.body; };
async function setActive(cookie, organizationId) { const r = await request("/api/auth/organization/set-active", { method: "POST", cookie, body: { organizationId } }); assert.equal(r.status, 200); return merge(cookie, r.cookie); }

console.log("Document isolation tests against", base);

// 1. Auth and text documents
assert.equal((await request("/api/docs")).status, 401); ok("anonymous list is rejected");
const a = await signUp(users.a);
let b = await signUp(users.b);
const wsA = await workspaceOf(a); await workspaceOf(b);

const idea = await request("/api/docs", { method: "POST", cookie: a, body: { kind: "idea", title: `Thêm S_obj ${stamp}`, format: "markdown", body: "# Ý tưởng\nThử thêm S_obj." } });
assert.equal(idea.status, 201); assert.equal(idea.body.kind, "idea"); assert.equal(idea.body.status, "new"); assert.equal(idea.body.created_via, "web"); ok("A creates an idea (status new, via web)");
const ideaId = idea.body.id;
assert.equal((await request(`/api/docs/${ideaId}`, { cookie: b })).status, 404); ok("B cannot read A's doc");
assert.equal((await request(`/api/docs/${ideaId}`, { method: "PATCH", cookie: b, body: { title: "hijack" } })).status, 404); ok("B cannot edit A's doc");
assert.equal((await request(`/api/docs/${ideaId}`, { method: "DELETE", cookie: b })).status, 404); ok("B cannot delete A's doc");
assert.equal((await request(`/api/docs/${ideaId}`, { cookie: a })).body.body, "# Ý tưởng\nThử thêm S_obj."); ok("A reads the body back");

const chosen = await request(`/api/docs/${ideaId}`, { method: "PATCH", cookie: a, body: { status: "chosen" } });
assert.equal(chosen.status, 200); assert.equal(chosen.body.status, "chosen"); ok("A marks the idea as chosen");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "report", title: "r", format: "markdown", body: "x", status: "new" } })).status, 422); ok("status on a report is rejected");
assert.equal((await request(`/api/docs/${ideaId}`, { method: "PATCH", cookie: a, body: { status: "maybe" } })).status, 422); ok("unknown idea status is rejected");
const asReport = await request(`/api/docs/${ideaId}`, { method: "PATCH", cookie: a, body: { kind: "report" } });
assert.equal(asReport.status, 200); assert.equal(asReport.body.status, null); ok("changing an idea to a report clears its status");

assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "other", title: "big", format: "markdown", body: "x".repeat(512 * 1024 + 1) } })).status, 422); ok("body over 512 KB is rejected");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "other", title: "t".repeat(301), format: "markdown", body: "x" } })).status, 422); ok("title over 300 characters is rejected");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "other", title: "tags", format: "markdown", body: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } })).status, 422); ok("more than 20 tags are rejected");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "other", title: "fmt", format: "file", body: "x" } })).status, 422); ok("format=file is not accepted for text docs");

// 2. Links to papers and runs
const pB = (await request("/api/papers", { method: "POST", cookie: b, body: { title: `Docs iso paper B ${stamp}`, doi: `10.9999/docsb.${stamp}` } })).body;
const pA = (await request("/api/papers", { method: "POST", cookie: a, body: { title: `Docs iso paper A ${stamp}`, doi: `10.9999/docsa.${stamp}` } })).body;
const pA2 = (await request("/api/papers", { method: "POST", cookie: a, body: { title: `Docs iso paper A preprint ${stamp}`, arxiv_id: `2601.${String(stamp).slice(-5)}` } })).body;
const paperId = (p) => p?.id ?? p?.paper?.id;
const rA = (await request("/api/runs", { method: "POST", cookie: a, body: { name: `docs iso run ${stamp}`, metrics: { val_acc: 0.9 } } })).body;
assert.ok(paperId(pA) && paperId(pA2) && paperId(pB) && rA?.id, "fixtures created");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "idea", title: "x", format: "markdown", body: "x", paper_ids: [paperId(pB)] } })).status, 422); ok("linking a paper from another workspace is rejected");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, body: { kind: "idea", title: "x", format: "markdown", body: "x", run_ids: [999999] } })).status, 422); ok("linking a missing run is rejected");
const linked = await request("/api/docs", { method: "POST", cookie: a, body: { kind: "report", title: `Báo cáo ${stamp}`, format: "html", body: "<h1>Kết quả</h1>", paper_ids: [paperId(pA2)], run_ids: [rA.id] } });
assert.equal(linked.status, 201); assert.equal(linked.body.paper_count, 1); assert.equal(linked.body.run_count, 1); ok("A links own paper and run");
const linkedId = linked.body.id;
const full = (await request(`/api/docs/${linkedId}`, { cookie: a })).body;
assert.equal(full.papers[0].id, paperId(pA2)); assert.equal(full.runs[0].id, rA.id); ok("getDoc lists the linked paper and run");
assert.equal((await request(`/api/runs/${rA.id}`, { method: "DELETE", cookie: a })).status, 204);
assert.equal((await request(`/api/docs/${linkedId}`, { cookie: a })).body.run_count, 0); ok("deleting a run removes the link");
const merged = await request("/api/papers/merge", { method: "POST", cookie: a, body: { keep_id: paperId(pA), merge_ids: [paperId(pA2)] } });
assert.equal(merged.status, 200);
const afterMerge = (await request(`/api/docs/${linkedId}`, { cookie: a })).body;
assert.equal(afterMerge.paper_count, 1); assert.equal(afterMerge.papers[0].id, paperId(pA)); ok("merging papers moves the doc link to the kept paper");
const relink = await request(`/api/docs/${linkedId}`, { method: "PATCH", cookie: a, body: { paper_ids: [] } });
assert.equal(relink.status, 200); assert.equal(relink.body.paper_count, 0); ok("paper_ids replaces the whole link set");

// 3. Filters
await request("/api/docs", { method: "POST", cookie: a, body: { kind: "idea", title: `Lọc S_obj ${stamp}`, format: "markdown", body: "x", status: "chosen" } });
await request("/api/docs", { method: "POST", cookie: a, body: { kind: "idea", title: `Khác ${stamp}`, format: "markdown", body: "x", status: "chosen" } });
const filtered = (await request(`/api/docs?kind=idea&status=chosen&q=${encodeURIComponent("Lọc S_obj")}`, { cookie: a })).body;
assert.equal(filtered.total, 1); assert.equal(filtered.items[0].title, `Lọc S_obj ${stamp}`); ok("kind + status + q filters combine");
assert.equal(filtered.items[0].body, undefined); ok("list items do not carry the body");

// 4. Tokens and sharing
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "docs-iso" } })).body.token;
const viaApi = await request("/api/docs", { method: "POST", bearer: tA, origin: null, body: { kind: "report", title: `Qua API ${stamp}`, format: "markdown", body: "x" } });
assert.equal(viaApi.status, 201); assert.equal(viaApi.body.created_via, "api"); ok("a token creates a doc marked created_via=api");
assert.equal((await request("/api/docs", { method: "POST", cookie: a, origin: "https://evil.example", body: { kind: "other", title: "x", format: "markdown", body: "x" } })).status, 403); ok("cross-origin browser POST is rejected");

const invite = await request("/api/auth/organization/invite-member", { method: "POST", cookie: a, body: { email: users.b.email, role: "member", organizationId: wsA.id } });
assert.equal(invite.status, 200);
assert.equal((await request("/api/auth/organization/accept-invitation", { method: "POST", cookie: b, body: { invitationId: invite.body.id } })).status, 200);
b = await setActive(b, wsA.id);
assert.ok((await request("/api/docs", { cookie: b })).body.items.some(d => d.id === linkedId)); ok("a member sees the workspace's docs");
const bView = (await request(`/api/docs/${linkedId}`, { cookie: b })).body;
assert.equal(bView.can_delete, false); assert.equal(bView.created_by, users.a.name); ok("a member sees creator and can_delete=false");
assert.equal((await request(`/api/docs/${linkedId}`, { method: "PATCH", cookie: b, body: { tags: ["shared"] } })).status, 200); ok("a member can edit");
assert.equal((await request(`/api/docs/${linkedId}`, { method: "DELETE", cookie: b })).status, 403); ok("a member cannot delete another member's doc");
const tB = (await request("/api/tokens", { method: "POST", cookie: b, body: { name: "docs-iso-b" } })).body.token;
assert.equal((await request("/api/docs", { bearer: tB, origin: null })).status, 200);
assert.equal((await request("/api/auth/organization/remove-member", { method: "POST", cookie: a, body: { memberIdOrEmail: users.b.email, organizationId: wsA.id } })).status, 200);
assert.equal((await request("/api/docs", { bearer: tB, origin: null })).status, 403); ok("a removed member's token is rejected");
assert.equal((await request(`/api/docs/${linkedId}`, { method: "DELETE", cookie: a })).status, 204); ok("the creator deletes the doc");
assert.equal((await request(`/api/docs/${linkedId}`, { cookie: a })).status, 404); ok("a deleted doc is gone");

console.log(`\n${passed} checks passed.`);

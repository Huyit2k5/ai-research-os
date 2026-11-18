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

// 5. File uploads (presigned PUT → complete → presigned GET). The server must run with MinIO S3_* env and STORAGE_LIMIT_MB=1.
const { AwsClient } = await import("aws4fetch");
const s3 = new AwsClient({ accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minio", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minio-secret-123", service: "s3", region: process.env.S3_REGION ?? "us-east-1" });
async function upload(cookie, { name, type, size, putBytes = size, putType = type, kind, complete = true }) {
  const start = await request("/api/docs/uploads", { method: "POST", cookie, body: { file_name: name, content_type: type, size, ...(kind ? { kind } : {}) } });
  if (start.status !== 200) return { start };
  const put = await fetch(start.body.upload_url, { method: "PUT", headers: { ...start.body.headers, "content-type": putType }, body: new Uint8Array(putBytes).fill(66) }).catch(e => ({ ok: false, status: 0, error: e }));
  const done = complete ? await request(`/api/docs/${start.body.id}/complete`, { method: "POST", cookie }) : null;
  return { start, put, done, id: start.body.id };
}
const pdfName = `Báo cáo tuần 46 "final".pdf`;
const pdf = await upload(a, { name: pdfName, type: "application/pdf", size: 1024, kind: "report" });
assert.equal(pdf.start.status, 200); assert.equal(pdf.put.ok, true, `PUT ${pdf.put.status}`); assert.equal(pdf.done.status, 200); assert.equal(pdf.done.body.format, "file"); assert.equal(pdf.done.body.file_size, 1024); assert.equal(pdf.done.body.kind, "report"); ok("A uploads a PDF through a presigned PUT");
assert.equal(pdf.done.body.title, pdfName); ok("title defaults to the file name");
const view = await request(`/api/docs/${pdf.id}/file`, { cookie: a });
assert.equal(view.status, 302); const viewUrl = view.headers.get("location"); assert.ok(viewUrl?.startsWith("http://127.0.0.1:59000/"), viewUrl); ok("GET /file redirects to the store");
const fileRes = await fetch(viewUrl);
assert.equal(fileRes.status, 200); assert.equal(fileRes.headers.get("content-type"), "application/pdf"); assert.equal((await fileRes.arrayBuffer()).byteLength, 1024);
const disp = fileRes.headers.get("content-disposition");
assert.ok(disp.startsWith("inline"), disp); assert.ok(disp.includes("filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20tu%E1%BA%A7n%2046%20%22final%22.pdf"), disp); ok("PDF is served inline with an RFC 5987 Vietnamese filename");
const dl = await fetch((await request(`/api/docs/${pdf.id}/file?download=1`, { cookie: a })).headers.get("location"));
assert.ok(dl.headers.get("content-disposition").startsWith("attachment")); ok("?download=1 forces attachment");
const asJson = await request(`/api/docs/${pdf.id}/file?url=1`, { cookie: a });
assert.equal(asJson.status, 200); assert.ok(asJson.body.url.startsWith("http://127.0.0.1:59000/")); ok("?url=1 returns the presigned URL as JSON (for fetch without a cross-origin redirect)");
assert.equal((await request(`/api/docs/${pdf.id}/file`, { cookie: b })).status, 404); ok("an outsider cannot get the file URL");
for (const [name, type, mode] of [["x.svg", "image/svg+xml", "attachment"], ["x.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "attachment"], ["x.html", "text/html", "inline"], ["x.png", "image/png", "inline"]]) {
  const u = await upload(a, { name, type, size: 16 });
  const d = (await fetch((await request(`/api/docs/${u.id}/file`, { cookie: a })).headers.get("location"))).headers.get("content-disposition");
  assert.ok(d.startsWith(mode), `${name}: ${d}`);
  await request(`/api/docs/${u.id}`, { method: "DELETE", cookie: a });
}
ok("only PDF, raster images and HTML are inline; SVG and Word are attachments");
const viHtml = await upload(a, { name: "vi.html", type: "text/html", size: 16 });
assert.equal((await fetch((await request(`/api/docs/${viHtml.id}/file`, { cookie: a })).headers.get("location"))).headers.get("content-type"), "text/html; charset=utf-8"); ok("text files are served as UTF-8 so Vietnamese without <meta charset> renders");
await request(`/api/docs/${viHtml.id}`, { method: "DELETE", cookie: a });
const noType = await upload(a, { name: "data.bin", type: "", size: 8, putType: "application/octet-stream" });
assert.equal(noType.done.status, 200); assert.equal(noType.done.body.file_type, "application/octet-stream"); ok("a missing content type becomes application/octet-stream");
await request(`/api/docs/${noType.id}`, { method: "DELETE", cookie: a });

const pending = await upload(a, { name: "pending.pdf", type: "application/pdf", size: 32, complete: false });
assert.equal((await request("/api/docs?q=pending.pdf", { cookie: a })).body.total, 0); ok("a pending upload is not listed");
assert.equal((await request(`/api/docs/${pending.id}`, { cookie: a })).status, 404); ok("a pending upload cannot be opened");
const wrongLen = await upload(a, { name: "len.pdf", type: "application/pdf", size: 1024, putBytes: 2048 });
assert.equal(wrongLen.put.ok, false); assert.equal(wrongLen.done.status, 422); ok("a PUT with a different length is refused and complete fails");
assert.equal((await request(`/api/docs/${wrongLen.id}/complete`, { method: "POST", cookie: a })).status, 404); ok("a failed complete deletes the pending row");
const nothing = await upload(a, { name: "none.pdf", type: "application/pdf", size: 64, putBytes: 0, complete: false });
assert.equal((await request(`/api/docs/${nothing.id}/complete`, { method: "POST", cookie: a })).status, 422); ok("complete without an uploaded file fails");
const spoof = await upload(a, { name: "spoof.pdf", type: "application/pdf", size: 64, complete: false });
await s3.fetch(spoof.start.body.upload_url.split("?")[0], { method: "PUT", headers: { "content-type": "text/html" }, body: new Uint8Array(64) });
assert.equal((await request(`/api/docs/${spoof.id}/complete`, { method: "POST", cookie: a })).status, 422); ok("complete rejects a stored type that differs from the declared one");
assert.equal((await request(`/api/docs/${pending.id}/complete`, { method: "POST", cookie: b })).status, 404); ok("an outsider cannot complete someone else's upload");

assert.equal((await request("/api/docs/uploads", { method: "POST", cookie: a, body: { file_name: "big.pdf", content_type: "application/pdf", size: 25 * 1024 * 1024 + 1 } })).status, 413); ok("a file over 25 MB is refused");
assert.equal((await request("/api/docs/uploads", { method: "POST", cookie: a, body: { file_name: "zero.pdf", content_type: "application/pdf", size: 0 } })).status, 422); ok("an empty file is refused");
const q1 = await upload(a, { name: "quota1.bin", type: "application/octet-stream", size: 600 * 1024 });
assert.equal(q1.done.status, 200);
assert.equal((await request("/api/docs/uploads", { method: "POST", cookie: a, body: { file_name: "quota2.bin", content_type: "application/octet-stream", size: 600 * 1024 } })).status, 413); ok("the project-wide storage limit is enforced");
await request(`/api/docs/${q1.id}`, { method: "DELETE", cookie: a });

assert.equal((await request(`/api/docs/${pdf.id}`, { method: "PATCH", cookie: a, body: { body: "x" } })).status, 422); ok("a file doc's content cannot be replaced by text");
assert.equal((await request(`/api/docs/${pdf.id}`, { method: "DELETE", cookie: a })).status, 204);
assert.equal((await fetch(viewUrl)).status, 404); ok("deleting a file doc removes the stored object");

// 6. MCP tools
const mcp = (bearer, method, params, id = 1) => request("/api/mcp", { method: "POST", bearer, origin: null, body: { jsonrpc: "2.0", id, method, params } });
const tool = async (bearer, name, args) => { const r = await mcp(bearer, "tools/call", { name, arguments: args }); return { isError: !!r.body?.result?.isError, data: (() => { try { return JSON.parse(r.body?.result?.content?.[0]?.text ?? "null"); } catch { return r.body?.result?.content?.[0]?.text; } })() }; };
const tools = (await mcp(tA, "tools/list", {})).body.result.tools;
for (const name of ["list_docs", "get_doc", "create_doc", "update_doc", "delete_doc"]) assert.ok(tools.some(t => t.name === name), name);
assert.equal(tools.find(t => t.name === "delete_doc").annotations.destructiveHint, true); assert.equal(tools.find(t => t.name === "get_doc").annotations.readOnlyHint, true); ok("tools/list has the 5 doc tools with hints");
const html = "<h1>Tuần 46</h1><script>alert(1)</script>";
const made = await tool(tA, "create_doc", { kind: "report", title: `MCP report ${stamp}`, format: "html", body: html, tags: ["mcp"] });
assert.equal(made.isError, false, JSON.stringify(made.data)); assert.equal(made.data.created_via, "api"); ok("create_doc creates a report via api");
const got = await tool(tA, "get_doc", { id: made.data.id });
assert.equal(got.data.body, html); assert.equal(got.data.format, "html"); ok("get_doc returns the body unchanged");
const rA2 = (await request("/api/runs", { method: "POST", cookie: a, body: { name: `docs iso run 2 ${stamp}`, metrics: { val_acc: 0.91 } } })).body;
const upd = await tool(tA, "update_doc", { id: made.data.id, run_ids: [rA2.id], title: `MCP report v2 ${stamp}` });
assert.equal(upd.isError, false, JSON.stringify(upd.data)); assert.equal(upd.data.run_count, 1); assert.equal(upd.data.title, `MCP report v2 ${stamp}`); ok("update_doc links a run and renames");
const listed = await tool(tA, "list_docs", { kind: "report", tag: "mcp" });
assert.ok(listed.data.items.some(d => d.id === made.data.id)); ok("list_docs filters by kind and tag");
assert.equal((await tool(tA, "create_doc", { kind: "report", title: "x", format: "file", body: "x" })).isError, true); ok("create_doc rejects format=file");
const tB2 = (await request("/api/tokens", { method: "POST", cookie: b, body: { name: "docs-iso-b2" } })).body.token;
assert.equal((await tool(tB2, "get_doc", { id: made.data.id })).isError, true); ok("another workspace's token cannot read the doc");
assert.equal((await tool(tB2, "delete_doc", { id: made.data.id })).isError, true); ok("another workspace's token cannot delete the doc");
assert.equal((await tool(tA, "delete_doc", { id: made.data.id })).isError, false);
assert.equal((await tool(tA, "get_doc", { id: made.data.id })).isError, true); ok("delete_doc removes the doc");

console.log(`\n${passed} checks passed.`);

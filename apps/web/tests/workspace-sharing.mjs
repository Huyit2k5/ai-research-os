// End-to-end checks for sharing papers, notes, experiment runs and API tokens inside a workspace.
// Usage: SHARING_TEST_BASE=http://localhost:3002 node tests/workspace-sharing.mjs
// Run only against a disposable database. Each run creates two users named share-iso-*@example.test and an extra
// workspace, and does not delete them. Kaggle capture is checked for permission only (dummy credential, no Kaggle call).
import assert from "node:assert/strict";

const base = process.env.SHARING_TEST_BASE ?? "http://localhost:3002";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("Set SHARING_TEST_BASE=http://localhost:<port> (a local test server).");
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
const tool = async (bearer, name, args) => { const r = await mcp(bearer, "tools/call", { name, arguments: args }); return { status: r.status, rpcError: r.body?.error ?? null, isError: !!r.body?.result?.isError, data: (() => { try { return JSON.parse(r.body?.result?.content?.[0]?.text ?? "null"); } catch { return r.body?.result?.content?.[0]?.text; } })() }; };
// A revoked workspace binding may surface as an HTTP error, a JSON-RPC error or a tool result with isError.
const toolFails = (t) => t.status >= 400 || !!t.rpcError || t.isError;
// Loose shapes: lists may be { items } or bare arrays; names may be plain strings or { name } objects; bulk may return a number or { affected, skipped }.
const itemsOf = (d) => Array.isArray(d) ? d : d?.items ?? d?.papers ?? d?.runs ?? [];
const nameOf = (v) => typeof v === "string" ? v : v?.name;
const affectedOf = (b) => typeof b === "number" ? b : typeof b?.affected === "number" ? b.affected : b?.affected?.affected;
const gone = (status) => [200, 204].includes(status);
// Better Auth may re-issue cookies (e.g. after set-active); keep the latest value of each.
const merge = (cookie, fresh) => { if (!fresh) return cookie; const m = new Map(); for (const part of `${cookie}; ${fresh}`.split("; ").filter(Boolean)) { const i = part.indexOf("="); m.set(part.slice(0, i), part.slice(i + 1)); } return [...m].map(([k, v]) => `${k}=${v}`).join("; "); };

const users = { a: { email: `share-iso-a-${stamp}@example.test`, password: `share-iso-password-${stamp}`, name: `Share A ${stamp}` }, b: { email: `share-iso-b-${stamp}@example.test`, password: `share-iso-password-${stamp}`, name: `Share B ${stamp}` } };
async function signUp(user) {
  const r = await request("/api/auth/sign-up/email", { method: "POST", body: user });
  assert.equal(r.status, 200, `sign-up ${user.email}`); assert.ok(r.cookie);
  return r.cookie;
}
const workspaceOf = async (cookie) => { const r = await request("/api/workspace", { cookie }); assert.equal(r.status, 200); return r.body; };
async function setActive(cookie, organizationId) {
  const r = await request("/api/auth/organization/set-active", { method: "POST", cookie, body: { organizationId } });
  assert.equal(r.status, 200, `set-active ${organizationId}`);
  return merge(cookie, r.cookie);
}
const papersOf = async (cookie) => { const r = await request("/api/papers?limit=100", { cookie }); assert.equal(r.status, 200); return itemsOf(r.body); };
const runsOf = async (cookie) => { const r = await request("/api/runs?limit=100", { cookie }); assert.equal(r.status, 200); return itemsOf(r.body); };

console.log("Workspace sharing tests against", base);
let a = await signUp(users.a), b = await signUp(users.b);

// 1. Each user starts in a private personal workspace
const wsA = await workspaceOf(a), wsB = await workspaceOf(b);
assert.ok(wsA.id && wsB.id); assert.notEqual(wsA.id, wsB.id);
assert.equal(wsA.role, "owner"); assert.equal(wsB.role, "owner"); assert.equal(wsA.name, "Cá nhân"); assert.equal(wsB.name, "Cá nhân"); ok("A and B each get a personal workspace they own");
assert.equal((await workspaceOf(a)).id, wsA.id); ok("the personal workspace is stable across requests");
const doi = `10.9999/share.${stamp}`;
const pA = await request("/api/papers", { method: "POST", cookie: a, body: { title: `Shared paper by A ${stamp}`, authors: ["Tester"], year: 2024, doi } });
assert.equal(pA.status, 201); const pAId = pA.body.id;
const rA = await request("/api/runs", { method: "POST", cookie: a, body: { name: `share run A ${stamp}`, config: { lr: 0.001, batch_size: 32 }, metrics: { val_acc: 0.8, train_loss: 0.4 }, status: "complete" } });
assert.equal(rA.status, 201); const rAId = rA.body.id; ok("A saves a paper and logs a run in A's personal workspace");
const pBPersonal = await request("/api/papers", { method: "POST", cookie: b, body: { title: `B personal paper ${stamp}`, authors: ["Tester"], year: 2023 } });
assert.equal(pBPersonal.status, 201); const pBPersonalId = pBPersonal.body.id;
assert.equal((await request(`/api/papers/${pAId}`, { cookie: b })).status, 404); assert.equal((await papersOf(b)).some(p => p.id === pAId), false); ok("B cannot see A's paper");
assert.equal((await request(`/api/runs/${rAId}`, { cookie: b })).status, 404); assert.equal((await runsOf(b)).some(r => r.id === rAId), false); ok("B cannot see A's run");
assert.equal((await request(`/api/papers/${pBPersonalId}`, { cookie: a })).status, 404); ok("A cannot see B's personal paper");

// 2. A renames the workspace (so token workspace names are distinguishable), invites B; B accepts and switches to it
const teamName = `Share team ${stamp}`;
assert.equal((await request("/api/auth/organization/update", { method: "POST", cookie: a, body: { data: { name: teamName }, organizationId: wsA.id } })).status, 200);
assert.equal((await workspaceOf(a)).name, teamName); ok("A renames the workspace");
const invite = await request("/api/auth/organization/invite-member", { method: "POST", cookie: a, body: { email: users.b.email, role: "member", organizationId: wsA.id } });
assert.equal(invite.status, 200); assert.ok(invite.body?.id);
assert.equal((await request("/api/auth/organization/accept-invitation", { method: "POST", cookie: b, body: { invitationId: invite.body.id } })).status, 200);
b = await setActive(b, wsA.id);
const wsBNow = await workspaceOf(b);
assert.equal(wsBNow.id, wsA.id); assert.equal(wsBNow.role, "member"); assert.equal(wsBNow.name, teamName); ok("B joins A's workspace as a member and sets it active");
const bSeesPA = (await papersOf(b)).find(p => p.id === pAId);
assert.ok(bSeesPA, "B lists A's paper"); assert.equal(nameOf(bSeesPA.added_by), users.a.name); assert.equal(bSeesPA.can_delete, false); ok("B sees A's paper with added_by = A and can_delete = false");
assert.equal((await papersOf(b)).some(p => p.id === pBPersonalId), false); ok("B's personal paper is not in the shared workspace");
assert.equal((await request(`/api/papers/${pAId}`, { cookie: b })).status, 200); ok("B can open A's paper");
const bSeesRA = (await runsOf(b)).find(r => r.id === rAId);
assert.ok(bSeesRA, "B lists A's run"); assert.equal(nameOf(bSeesRA.created_by), users.a.name); assert.equal(bSeesRA.can_delete, false); ok("B sees A's run with created_by = A and can_delete = false");
assert.equal((await request(`/api/runs/${rAId}`, { cookie: b })).status, 200); ok("B can open A's run");

// 3. Papers and notes in the shared workspace
const pB = await request("/api/papers", { method: "POST", cookie: b, body: { title: `Shared paper by B ${stamp}`, authors: ["Tester"], year: 2025, doi: `10.9999/share-b.${stamp}` } });
assert.equal(pB.status, 201); const pBId = pB.body.id;
const pB2 = await request("/api/papers", { method: "POST", cookie: b, body: { title: `Second paper by B ${stamp}`, authors: ["Tester"], year: 2025 } });
assert.equal(pB2.status, 201); const pB2Id = pB2.body.id; ok("B adds papers in the shared workspace");
const aSeesPB = (await papersOf(a)).find(p => p.id === pBId);
assert.ok(aSeesPB, "A lists B's paper"); assert.equal(nameOf(aSeesPB.added_by), users.b.name); assert.equal(aSeesPB.can_delete, true); ok("A (owner) sees B's paper with added_by = B and can_delete = true");
assert.equal((await papersOf(b)).find(p => p.id === pBId)?.can_delete, true); ok("B sees can_delete = true on own paper");
const nB = await request(`/api/papers/${pAId}/notes`, { method: "POST", cookie: b, body: { body: "note by B" } });
assert.equal(nB.status, 201); ok("B adds a note to A's paper");
const nA = await request(`/api/papers/${pAId}/notes`, { method: "POST", cookie: a, body: { body: "note by A" } });
assert.equal(nA.status, 201);
const notesForA = (await request(`/api/papers/${pAId}`, { cookie: a })).body.notes;
const bNoteForA = notesForA.find(n => n.id === nB.body.id), aNoteForA = notesForA.find(n => n.id === nA.body.id);
assert.ok(bNoteForA && aNoteForA, "A sees both notes"); assert.equal(nameOf(bNoteForA.author), users.b.name); assert.equal(bNoteForA.mine, false); assert.equal(aNoteForA.mine, true); ok("A sees B's note with author = B and mine = false");
const aNoteForB = (await request(`/api/papers/${pAId}`, { cookie: b })).body.notes.find(n => n.id === nA.body.id);
assert.equal(nameOf(aNoteForB.author), users.a.name); assert.equal(aNoteForB.mine, false); ok("B sees A's note with author = A and mine = false");
assert.equal((await request(`/api/papers/${pAId}/notes?note_id=${nA.body.id}`, { method: "PATCH", cookie: b, body: { body: "hijack" } })).status, 403); ok("B cannot edit A's note (403)");
assert.equal((await request(`/api/papers/${pAId}/notes?note_id=${nB.body.id}`, { method: "PATCH", cookie: b, body: { body: "edited by B" } })).body.body, "edited by B"); ok("B can edit own note");
const tagged = await request(`/api/papers/${pAId}`, { method: "PATCH", cookie: b, body: { tags: ["shared-tag"], read_status: "reading" } });
assert.equal(tagged.status, 200); assert.deepEqual(tagged.body.tags, ["shared-tag"]); assert.equal(tagged.body.read_status, "reading");
assert.deepEqual((await request(`/api/papers/${pAId}`, { cookie: a })).body.tags, ["shared-tag"]); ok("B can edit tags and read status of A's paper; A sees the change");
assert.equal(affectedOf((await request("/api/papers/bulk", { method: "POST", cookie: b, body: { ids: [pAId], action: "add_tag", value: "bulk-tag" } })).body), 1); ok("B's bulk tag reaches A's paper");
assert.equal(affectedOf((await request("/api/papers/bulk", { method: "POST", cookie: b, body: { ids: [pAId], action: "status", value: "read" } })).body), 1); ok("B's bulk status reaches A's paper");
// Read status is per member: B marked A's paper as read; A's own status is untouched and A can see who read it.
const aView = (await request(`/api/papers/${pAId}`, { cookie: a })).body;
assert.equal(aView.read_status, "to_read"); assert.equal(aView.read_count, 1); assert.ok(aView.member_count >= 2);
assert.ok(aView.readers.some(r => nameOf(r) === users.b.name && r.status === "read" && r.mine === false)); ok("B's read status does not change A's; A sees B among the readers");
assert.equal((await request(`/api/papers/${pAId}`, { cookie: b })).body.read_status, "read"); ok("B still sees own status");
assert.equal(itemsOf((await request("/api/papers?readers=none&limit=100", { cookie: a })).body).some(p => p.id === pAId), false); ok("readers=none excludes a paper someone has read");
assert.equal(itemsOf((await request("/api/papers?readers=others&limit=100", { cookie: a })).body).some(p => p.id === pAId), true); ok("readers=others lists it for A (B read it, A has not)");
assert.equal(itemsOf((await request("/api/papers?readers=others&limit=100", { cookie: b })).body).some(p => p.id === pAId), false); ok("readers=others excludes it for B (B already read it)");
assert.equal(itemsOf((await request("/api/papers?status=read&limit=100", { cookie: a })).body).some(p => p.id === pAId), false); assert.equal(itemsOf((await request("/api/papers?status=read&limit=100", { cookie: b })).body).some(p => p.id === pAId), true); ok("status filter is the caller's own");
assert.equal((await request(`/api/papers/${pAId}`, { method: "PATCH", cookie: a, body: { read_status: "reading" } })).body.read_status, "reading");
assert.equal((await request(`/api/papers/${pAId}`, { cookie: b })).body.read_status, "read"); ok("A's status change leaves B's alone");
assert.equal((await request(`/api/papers/${pAId}`, { method: "PATCH", cookie: a, body: { read_status: "to_read" } })).body.read_status, "to_read"); ok("setting to_read clears own status");
const bulkDel = await request("/api/papers/bulk", { method: "POST", cookie: b, body: { ids: [pAId], action: "delete" } });
assert.equal(affectedOf(bulkDel.body), 0); assert.equal((await request(`/api/papers/${pAId}`, { cookie: a })).status, 200); ok("B's bulk delete skips A's paper");
assert.equal((await request("/api/papers/merge", { method: "POST", cookie: b, body: { keep_id: pBId, merge_ids: [pAId] } })).status, 403); ok("B cannot merge A's paper away (403)");
assert.equal((await request(`/api/papers/${pAId}`, { method: "DELETE", cookie: b })).status, 403); ok("B cannot delete A's paper (403)");
assert.equal((await request(`/api/papers/${pAId}`, { cookie: a })).status, 200); ok("A's paper survives B's attempts");
assert.ok(gone((await request(`/api/papers/${pB2Id}`, { method: "DELETE", cookie: b })).status)); assert.equal((await request(`/api/papers/${pB2Id}`, { cookie: a })).status, 404); ok("B can delete own paper");
assert.ok(gone((await request(`/api/papers/${pBId}`, { method: "DELETE", cookie: a })).status)); assert.equal((await request(`/api/papers/${pBId}`, { cookie: b })).status, 404); ok("A (owner) can delete B's paper");

// 4. Duplicates are per workspace
const dupInShared = await request("/api/papers", { method: "POST", cookie: b, body: { title: `Same DOI from B ${stamp}`, doi } });
assert.equal(dupInShared.body.created, false); assert.equal(dupInShared.body.id, pAId); ok("the same DOI is not duplicated inside one workspace, even by another member");
const second = await request("/api/auth/organization/create", { method: "POST", cookie: a, body: { name: `Share second ${stamp}`, slug: `share-iso-${stamp}` } });
assert.equal(second.status, 200); assert.ok(second.body?.id); a = merge(a, second.cookie);
a = await setActive(a, second.body.id); // create already activates it; set it explicitly anyway
assert.equal((await workspaceOf(a)).id, second.body.id); ok("A creates and switches to a second workspace");
assert.equal((await papersOf(a)).some(p => p.id === pAId), false); ok("the second workspace does not show the shared workspace's papers");
const dupOther = await request("/api/papers", { method: "POST", cookie: a, body: { title: `Shared paper by A ${stamp}`, authors: ["Tester"], year: 2024, doi } });
assert.equal(dupOther.status, 201); assert.equal(dupOther.body.created, true); assert.notEqual(dupOther.body.id, pAId); ok("the same DOI can be saved again in another workspace");
assert.equal((await request("/api/papers", { method: "POST", cookie: a, body: { title: "again", doi } })).body.id, dupOther.body.id); ok("within the second workspace the DOI is de-duplicated");
a = await setActive(a, wsA.id);
assert.equal((await workspaceOf(a)).id, wsA.id); ok("A switches back to the shared workspace");

// 5. Runs in the shared workspace
const runB = (name) => request("/api/runs", { method: "POST", cookie: b, body: { name, config: { lr: 0.0003, batch_size: 32 }, metrics: { val_acc: 0.85, train_loss: 0.3 }, status: "complete" } });
const rB = await runB(`share run B ${stamp}`), rB2 = await runB(`share run B2 ${stamp}`), rB3 = await runB(`share run B3 ${stamp}`);
assert.equal(rB.status, 201); assert.equal(rB2.status, 201); assert.equal(rB3.status, 201); const rBId = rB.body.id; ok("B logs manual runs in the shared workspace");
const aSeesRB = (await runsOf(a)).find(r => r.id === rBId);
assert.ok(aSeesRB, "A lists B's run"); assert.equal(nameOf(aSeesRB.created_by), users.b.name); assert.equal(aSeesRB.can_delete, true); ok("A sees B's run with created_by = B and can_delete = true");
const cmp = await request(`/api/runs/compare?ids=${rAId},${rBId}`, { cookie: a });
assert.equal(cmp.status, 200); assert.deepEqual(cmp.body.runs.map(r => r.id), [rAId, rBId]); assert.deepEqual(cmp.body.config_diff.map(c => c.key), ["lr"]); ok("A compares A's and B's runs");
assert.equal((await request(`/api/runs/compare?ids=${rAId},${rBId}`, { cookie: b })).status, 200); ok("B can compare too");
const editedRA = await request(`/api/runs/${rAId}`, { method: "PATCH", cookie: b, body: { notes: "reviewed by B", tags: ["shared"] } });
assert.equal(editedRA.status, 200); assert.equal(editedRA.body.notes, "reviewed by B"); ok("B can edit notes and tags of A's run");
assert.equal((await request(`/api/runs/${rAId}`, { method: "DELETE", cookie: b })).status, 403); assert.equal((await request(`/api/runs/${rAId}`, { cookie: a })).status, 200); ok("B cannot delete A's run (403)");
assert.equal((await request(`/api/runs/${rBId}`, { method: "PATCH", cookie: b, body: { paper_id: pBPersonalId } })).status, 422); ok("B cannot link a run to a paper from B's personal workspace (422)");
assert.equal((await request("/api/runs", { method: "POST", cookie: b, body: { name: "cross-workspace link", paper_id: pBPersonalId } })).status, 422); ok("B cannot create a run linked to a paper from another workspace (422)");
assert.equal((await request(`/api/runs/${rBId}`, { method: "PATCH", cookie: b, body: { paper_id: pAId } })).body.paper_id, pAId); ok("B can link own run to A's paper in the same workspace");
assert.ok(gone((await request(`/api/runs/${rB3.body.id}`, { method: "DELETE", cookie: b })).status)); ok("B can delete own run");
assert.ok(gone((await request(`/api/runs/${rB2.body.id}`, { method: "DELETE", cookie: a })).status)); assert.equal((await request(`/api/runs/${rB2.body.id}`, { cookie: b })).status, 404); ok("A (owner) can delete B's run");

// 6. Any member may capture through a workspace connection
const acc = await request("/api/accounts", { method: "POST", cookie: a, body: { label: `share-iso ${stamp}`, username: "share-iso", token: "dummy-token" } });
assert.equal(acc.status, 201);
const cap = await request("/api/runs/capture", { method: "POST", cookie: b, body: { account_id: acc.body.id, ref: "share-iso/notebook" } });
assert.ok(![401, 403, 404].includes(cap.status), `B is allowed to capture through A's connection (Kaggle rejects the dummy token): ${cap.status}`); ok("B may capture through A's connection in the shared workspace (not blocked by ownership)");

// 7. Tokens are bound to the workspace active when they were created
const tShared = await request("/api/tokens", { method: "POST", cookie: b, body: { name: "share-iso shared" } });
assert.equal(tShared.status, 201); assert.ok(tShared.body.token?.startsWith("ros_"));
const sharedPapers = itemsOf((await tool(tShared.body.token, "list_papers", {})).data);
assert.ok(sharedPapers.some(p => p.id === pAId)); assert.equal(sharedPapers.some(p => p.id === pBPersonalId), false); ok("B's shared-workspace token lists the shared papers");
const sharedRuns = itemsOf((await tool(tShared.body.token, "list_runs", {})).data);
assert.ok(sharedRuns.some(r => r.id === rAId) && sharedRuns.some(r => r.id === rBId)); ok("B's shared-workspace token lists A's and B's runs");
b = await setActive(b, wsB.id);
assert.equal((await workspaceOf(b)).id, wsB.id); ok("B switches back to the personal workspace");
const tPersonal = await request("/api/tokens", { method: "POST", cookie: b, body: { name: "share-iso personal" } });
assert.equal(tPersonal.status, 201);
const tokenList = (await request("/api/tokens", { cookie: b })).body;
assert.equal(tokenList.find(t => t.id === tShared.body.id)?.workspace_name, teamName); assert.equal(tokenList.find(t => t.id === tPersonal.body.id)?.workspace_name, "Cá nhân"); ok("GET /api/tokens shows each token's workspace_name");
const personalPapers = itemsOf((await tool(tPersonal.body.token, "list_papers", {})).data);
assert.equal(personalPapers.some(p => p.id === pAId), false); assert.ok(personalPapers.some(p => p.id === pBPersonalId)); ok("B's personal token sees only the personal library");
assert.equal(itemsOf((await tool(tPersonal.body.token, "list_runs", {})).data).some(r => r.id === rAId || r.id === rBId), false); ok("B's personal token does not see shared runs");
assert.ok(itemsOf((await tool(tShared.body.token, "list_papers", {})).data).some(p => p.id === pAId)); ok("the shared token keeps its workspace after B switches in the browser");
assert.equal((await request("/api/auth/organization/remove-member", { method: "POST", cookie: a, body: { memberIdOrEmail: users.b.email, organizationId: wsA.id } })).status, 200); ok("A removes B from the workspace");
assert.ok(toolFails(await tool(tShared.body.token, "list_papers", {}))); assert.ok(toolFails(await tool(tShared.body.token, "list_runs", {}))); ok("B's shared-workspace token fails after removal");
assert.ok(toolFails(await tool(tShared.body.token, "get_paper", { id: pAId }))); ok("B's shared-workspace token cannot read A's paper after removal");
assert.ok(itemsOf((await tool(tPersonal.body.token, "list_papers", {})).data).some(p => p.id === pBPersonalId)); ok("B's personal token still works");
assert.equal((await request(`/api/papers/${pAId}`, { cookie: b })).status, 404); assert.equal((await request(`/api/runs/${rAId}`, { cookie: b })).status, 404); ok("B's browser session loses access to shared items");
assert.equal((await request(`/api/runs/${rBId}`, { cookie: a })).status, 200); ok("B's run stays in the workspace after B leaves");

// 8. Cleanup of the dummy Kaggle connection (users and workspaces are kept, as in the other scripts)
assert.equal((await request(`/api/accounts/${acc.body.id}`, { method: "DELETE", cookie: a })).status, 204);

console.log(`\n${passed} checks passed.`);

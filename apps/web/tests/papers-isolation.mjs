// End-to-end checks for the paper library, personal tokens and the MCP endpoint.
// Usage: PAPERS_TEST_BASE=http://localhost:3002 node tests/papers-isolation.mjs
// Prefer a disposable database. Each run creates two users named papers-iso-*@example.test and does not delete them.
import assert from "node:assert/strict";

const base = process.env.PAPERS_TEST_BASE;
if (!base || !/^http:\/\/localhost:\d+$/.test(base))
  throw new Error("Set PAPERS_TEST_BASE=http://localhost:<port> (a local test server).");
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
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
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
  return { status: res.status, body: data, cookie: cookies };
}
const mcp = (bearer, method, params, id = 1) =>
  request("/api/mcp", { method: "POST", bearer, origin: null, body: { jsonrpc: "2.0", id, method, params } });
const tool = async (bearer, name, args) => {
  const r = await mcp(bearer, "tools/call", { name, arguments: args });
  return {
    isError: !!r.body?.result?.isError,
    data: (() => {
      try {
        return JSON.parse(r.body?.result?.content?.[0]?.text ?? "null");
      } catch {
        return r.body?.result?.content?.[0]?.text;
      }
    })(),
  };
};

async function signUp(tag) {
  const r = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      email: `papers-iso-${tag}-${stamp}@example.test`,
      password: `papers-iso-password-${stamp}`,
      name: `Iso ${tag}`,
    },
  });
  assert.equal(r.status, 200, `sign-up ${tag}`);
  assert.ok(r.cookie);
  return r.cookie;
}

console.log("Paper library isolation tests against", base);
const a = await signUp("a"),
  b = await signUp("b");
const paper = {
  title: `Isolation test paper ${stamp}`,
  authors: ["Tester"],
  year: 2024,
  abstract: "contrastive isolation check",
  doi: `10.9999/iso.${stamp}`,
};

// Ownership
const saved = await request("/api/papers", { method: "POST", cookie: a, body: paper });
assert.equal(saved.status, 201);
const pid = saved.body.id;
ok("A saves a paper");
assert.equal((await request("/api/papers", { method: "POST", cookie: a, body: paper })).body.created, false);
ok("saving the same DOI again does not duplicate");
assert.equal((await request(`/api/papers/${pid}`, { cookie: b })).status, 404);
ok("B cannot read A's paper");
assert.equal(
  (await request(`/api/papers/${pid}`, { method: "PATCH", cookie: b, body: { title: "hijack" } })).status,
  404,
);
ok("B cannot edit A's paper");
assert.equal((await request(`/api/papers/${pid}`, { method: "DELETE", cookie: b })).status, 404);
ok("B cannot delete A's paper");
assert.equal(
  (await request(`/api/papers/${pid}/notes`, { method: "POST", cookie: b, body: { body: "x" } })).status,
  404,
);
ok("B cannot add a note to A's paper");
const note = await request(`/api/papers/${pid}/notes`, { method: "POST", cookie: a, body: { body: "note by A" } });
assert.equal(note.status, 201);
assert.equal(
  (
    await request(`/api/papers/${pid}/notes?note_id=${note.body.id}`, {
      method: "PATCH",
      cookie: b,
      body: { body: "hijack" },
    })
  ).status,
  404,
);
ok("B cannot edit A's note");
assert.equal(
  (
    await request(`/api/papers/${pid}/notes?note_id=${note.body.id}`, {
      method: "PATCH",
      cookie: a,
      body: { body: "edited by A" },
    })
  ).body.body,
  "edited by A",
);
ok("A can edit own note");
assert.equal((await request("/api/papers", { cookie: b })).body.total, 0);
ok("B's library list is empty");
assert.equal((await request("/api/papers?q=isolation", { cookie: a })).body.total, 1);
ok("A's filtered list finds the paper");

// CSRF and auth
assert.equal(
  (await request("/api/papers", { method: "POST", cookie: a, origin: "http://evil.example", body: paper })).status,
  403,
);
ok("cross-origin write is rejected");
assert.equal((await request("/api/papers")).status, 401);
ok("anonymous list is rejected");
assert.equal(
  (await request("/api/papers/import", { method: "POST", cookie: a, body: { identifier: "not an id" } })).status,
  422,
);
ok("invalid DOI/arXiv identifier is rejected");

// Tokens and MCP
const tA = (await request("/api/tokens", { method: "POST", cookie: a, body: { name: "iso" } })).body.token;
const tB = (await request("/api/tokens", { method: "POST", cookie: b, body: { name: "iso" } })).body.token;
assert.ok(tA?.startsWith("ros_") && tB?.startsWith("ros_"));
assert.equal(
  (await request("/api/tokens", { method: "POST", bearer: tA, origin: null, body: { name: "x" } })).status,
  401,
);
ok("a token cannot create more tokens");
assert.equal((await mcp(null, "ping")).status, 401);
ok("MCP without token is rejected");
assert.equal(
  (
    await request("/api/mcp", {
      method: "POST",
      cookie: a,
      origin: null,
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    })
  ).status,
  401,
);
ok("MCP with only a session cookie is rejected");
const names = (await mcp(tA, "tools/list")).body.result.tools.map((t) => t.name);
for (const n of [
  "search_papers",
  "import_paper",
  "save_paper",
  "list_papers",
  "search_library",
  "get_paper",
  "update_paper",
  "delete_paper",
  "list_tags",
  "export_bibtex",
  "refresh_metadata",
  "find_duplicates",
  "merge_papers",
  "list_notes",
  "add_note",
])
  assert.ok(names.includes(n), n);
ok("MCP lists the paper tools");
assert.equal((await tool(tB, "get_paper", { id: pid })).isError, true);
ok("B's token cannot read A's paper");
assert.equal((await tool(tB, "list_notes", { paper_id: pid })).isError, true);
ok("B's token cannot list A's notes");
assert.equal((await tool(tB, "update_paper", { id: pid, title: "hijack" })).isError, true);
ok("B's token cannot edit A's paper");
assert.equal((await tool(tB, "delete_paper", { id: pid })).isError, true);
ok("B's token cannot delete A's paper");
assert.equal((await tool(tB, "list_papers", {})).data.total, 0);
ok("B's token sees an empty library");
assert.equal((await tool(tB, "search_library", { query: "isolation" })).data.length, 0);
ok("B's search_library does not leak A's papers");
assert.equal((await tool(tA, "search_library", { query: "isolation contrastive" })).data[0]?.id, pid);
ok("A's search_library ranks the paper");
assert.equal((await tool(tA, "update_paper", { id: pid, year: 2025 })).data.updated, true);
ok("A's token can edit own paper");
assert.equal((await request(`/api/papers/${pid}`, { cookie: a })).body.title, paper.title);
ok("A's paper is intact after B's attempts");

// Tags, read status, bulk actions and BibTeX
const tagged = await request(`/api/papers/${pid}`, {
  method: "PATCH",
  cookie: a,
  body: { tags: ["luận văn", "Graph", "graph"], read_status: "reading" },
});
assert.deepEqual(tagged.body.tags, ["luận văn", "Graph"]);
assert.equal(tagged.body.read_status, "reading");
ok("tags are de-duplicated case-insensitively; status is saved");
assert.equal(
  (await request(`/api/papers/${pid}`, { method: "PATCH", cookie: a, body: { read_status: "done" } })).status,
  422,
);
ok("invalid read status is rejected");
assert.equal(
  (await request(`/api/papers?tag=${encodeURIComponent("luận văn")}&status=reading`, { cookie: a })).body.total,
  1,
);
ok("list filters by tag and status");
assert.deepEqual((await request("/api/papers/tags", { cookie: b })).body, []);
ok("B does not see A's tags");
assert.equal(
  (await request("/api/papers/bulk", { method: "POST", cookie: b, body: { ids: [pid], action: "delete" } })).body
    .affected,
  0,
);
ok("B's bulk delete does not touch A's paper");
assert.equal(
  (
    await request("/api/papers/bulk", {
      method: "POST",
      cookie: b,
      body: { ids: [pid], action: "add_tag", value: "x" },
    })
  ).body.affected,
  0,
);
ok("B's bulk tag does not touch A's paper");
assert.equal((await request(`/api/papers/export?inline=1&ids=${pid}`, { cookie: b })).body, null);
ok("B's BibTeX export of A's id is empty");
const bibA = await request(`/api/papers/export?inline=1&ids=${pid}`, { cookie: a });
assert.match(String(bibA.body), /@misc\{tester2025isolation,/);
assert.match(String(bibA.body), /doi = \{10\.9999\/iso\./);
ok("A's BibTeX export has the entry");
assert.equal(
  (
    await request("/api/papers/bulk", {
      method: "POST",
      cookie: a,
      body: { ids: [pid], action: "status", value: "read" },
    })
  ).body.affected,
  1,
);
ok("A's bulk status works");
const noId = { title: `Paper without identifiers ${stamp}`, authors: ["Tester"], year: 2023 };
const n1 = await request("/api/papers", { method: "POST", cookie: a, body: noId }),
  n2 = await request("/api/papers", {
    method: "POST",
    cookie: a,
    body: { ...noId, title: noId.title.toUpperCase() + "." },
  });
assert.equal(n1.body.created, true);
assert.equal(n2.body.created, false);
assert.equal(n2.body.id, n1.body.id);
ok("same title and year without identifiers is not duplicated");
assert.equal((await tool(tA, "export_bibtex", { ids: [pid] })).data.count, 1);
assert.equal((await tool(tB, "export_bibtex", { ids: [pid] })).data.count, 0);
ok("MCP export_bibtex is owner-scoped");
assert.equal((await tool(tB, "list_tags", {})).data.length, 0);
ok("MCP list_tags is owner-scoped");

// Duplicates and merge (a preprint and a journal version of the same title)
const preprint = (
  await request("/api/papers", {
    method: "POST",
    cookie: a,
    body: {
      title: `Merge test ${stamp}: a study`,
      authors: ["Tester"],
      year: 2021,
      arxiv_id: `2101.${String(stamp).slice(-5)}`,
    },
  })
).body;
const journal = (
  await request("/api/papers", {
    method: "POST",
    cookie: a,
    body: {
      title: `Merge test ${stamp}: A Study.`,
      authors: ["Tester"],
      year: 2022,
      doi: `10.9999/merge.${stamp}`,
      venue: "Journal of Tests",
      venue_type: "journal",
    },
  })
).body;
assert.equal(journal.created, true);
ok("journal version with a different year is saved separately");
await request(`/api/papers/${preprint.id}/notes`, { method: "POST", cookie: a, body: { body: "note on preprint" } });
await request(`/api/papers/${preprint.id}`, {
  method: "PATCH",
  cookie: a,
  body: { tags: ["survey"], read_status: "read" },
});
const groupsA = (await request("/api/papers/duplicates", { cookie: a })).body;
assert.ok(groupsA.some((g) => g.some((p) => p.id === preprint.id) && g.some((p) => p.id === journal.id)));
ok("duplicates groups the preprint with the journal version");
assert.deepEqual((await request("/api/papers/duplicates", { cookie: b })).body, []);
ok("B sees no duplicate groups from A");
assert.equal(
  (
    await request("/api/papers/merge", {
      method: "POST",
      cookie: b,
      body: { keep_id: journal.id, merge_ids: [preprint.id] },
    })
  ).status,
  404,
);
ok("B cannot merge A's papers");
const bOwn = (await request("/api/papers", { method: "POST", cookie: b, body: { title: `B's own paper ${stamp}` } }))
  .body;
assert.equal(
  (
    await request("/api/papers/merge", {
      method: "POST",
      cookie: a,
      body: { keep_id: journal.id, merge_ids: [bOwn.id] },
    })
  ).status,
  404,
);
ok("A cannot merge B's paper into own");
assert.equal((await request(`/api/papers/${bOwn.id}`, { cookie: b })).status, 200);
ok("B's paper survives A's merge attempt");
const merged = await request("/api/papers/merge", {
  method: "POST",
  cookie: a,
  body: { keep_id: journal.id, merge_ids: [preprint.id] },
});
assert.equal(merged.status, 200);
assert.equal(merged.body.merged, 1);
assert.equal(merged.body.notes_moved, 1);
const kept = (await request(`/api/papers/${journal.id}`, { cookie: a })).body;
assert.equal(kept.arxiv_id, preprint.arxiv_id);
assert.equal(kept.doi, journal.doi);
assert.deepEqual(kept.tags, ["survey"]);
assert.equal(kept.read_status, "read");
assert.equal(kept.notes.length, 1);
ok("merge moves notes, unions tags, keeps the furthest read status and fills missing ids");
assert.equal((await request(`/api/papers/${preprint.id}`, { cookie: a })).status, 404);
ok("merged copy is deleted");
assert.equal((await tool(tB, "merge_papers", { keep_id: journal.id, merge_ids: [pid] })).isError, true);
ok("B's token cannot merge A's papers");
const refreshed = await request("/api/papers/refresh", { method: "POST", cookie: b, body: { ids: [pid] } });
assert.equal(refreshed.status, 404);
ok("B cannot refresh A's paper");
const refA = await request("/api/papers/refresh", { method: "POST", cookie: a, body: { ids: [pid] } });
assert.equal(refA.status, 200);
assert.equal(refA.body.missing.length, 1);
ok("refresh reports papers OpenAlex does not know (fake DOI)");

// Revocation
const tokenList = (await request("/api/tokens", { cookie: a })).body;
assert.equal((await request(`/api/tokens?id=${tokenList[0].id}`, { method: "DELETE", cookie: a })).status, 204);
assert.equal((await mcp(tA, "ping")).status, 401);
ok("revoked token loses access");

// Rate limit (short queries are rejected after the limiter, so no external API is called)
let last;
for (let i = 0; i < 21; i++) last = await request("/api/papers/search?q=x", { cookie: b });
assert.equal(last.status, 429);
ok("search is rate limited after 20 requests per minute");

console.log(`\n${passed} checks passed.`);

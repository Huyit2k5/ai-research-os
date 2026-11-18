// Run only against a disposable test database and the test server on port 3002.
import assert from "node:assert/strict";
const base = process.env.AUTH_TEST_BASE;
if (base !== "http://localhost:3002")
  throw new Error("Set AUTH_TEST_BASE=http://localhost:3002 for a disposable test instance.");
const users = [
  { email: "first@example.test", password: "first-test-password-2026", name: "First" },
  { email: "second@example.test", password: "second-test-password-2026", name: "Second" },
];
async function request(path, { method = "GET", body, cookie, origin = base } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookie: cookies };
}
assert.equal((await request("/api/accounts")).status, 401);
const first = await request("/api/auth/sign-up/email", { method: "POST", body: users[0] });
const second = await request("/api/auth/sign-up/email", { method: "POST", body: users[1] });
assert.equal(first.status, 200);
assert.equal(second.status, 200);
assert.ok(first.cookie && second.cookie);
const firstAccounts = await request("/api/accounts", { cookie: first.cookie });
assert.equal(firstAccounts.body.length, 1); // seeded pre-auth account is assigned to first user
assert.equal((await request("/api/accounts", { cookie: second.cookie })).body.length, 0);
assert.equal(
  (
    await request(`/api/accounts/${firstAccounts.body[0].id}/notebook-logs?ref=owner%2Fnotebook`, {
      cookie: second.cookie,
    })
  ).status,
  404,
);
const created = await request("/api/accounts", {
  method: "POST",
  cookie: first.cookie,
  body: { label: "demo", username: "demo", token: "dummy-token" },
});
assert.equal(created.status, 201);
assert.equal("credential" in created.body, false);
assert.equal(
  (await request(`/api/accounts/${created.body.id}`, { method: "DELETE", cookie: second.cookie })).status,
  404,
);
assert.equal(
  (
    await request(`/api/accounts/${created.body.id}`, {
      method: "DELETE",
      cookie: first.cookie,
      origin: "https://untrusted.invalid",
    })
  ).status,
  403,
);
assert.equal((await request("/api/auth/sign-out", { method: "POST", cookie: first.cookie, body: {} })).status, 200);
assert.equal((await request("/api/accounts", { cookie: first.cookie })).status, 401);
assert.notEqual(
  (
    await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: users[0].email, password: "wrong-password-2026" },
    })
  ).status,
  200,
);
const login = await request("/api/auth/sign-in/email", {
  method: "POST",
  body: { email: users[0].email, password: users[0].password },
});
assert.equal(login.status, 200);
assert.equal((await request("/api/accounts", { cookie: login.cookie })).body.length, 2);

// Workspace sharing: members see everything, but only a connection's creator may use its token.
const workspace = (await request("/api/workspace", { cookie: login.cookie })).body;
assert.equal(workspace.role, "owner");
const invite = await request("/api/auth/organization/invite-member", {
  method: "POST",
  cookie: login.cookie,
  body: { email: users[1].email, role: "member", organizationId: workspace.id },
});
assert.equal(invite.status, 200);
assert.equal(
  (
    await request("/api/auth/organization/accept-invitation", {
      method: "POST",
      cookie: second.cookie,
      body: { invitationId: invite.body.id },
    })
  ).status,
  200,
);
assert.equal(
  (
    await request("/api/auth/organization/set-active", {
      method: "POST",
      cookie: second.cookie,
      body: { organizationId: workspace.id },
    })
  ).status,
  200,
);
assert.equal((await request("/api/workspace", { cookie: second.cookie })).body.id, workspace.id);
const shared = (await request("/api/accounts", { cookie: second.cookie })).body;
assert.equal(shared.length, 2);
assert.ok(
  shared.every((account) => account.mine === false && account.can_delete === false && account.creator === "First"),
);
const target = shared[0].id,
  ref = "ref=owner%2Fnotebook";
// A member cannot replace someone else's token or delete their connection...
for (const [path, method, body] of [
  [`/api/accounts/${target}/credential`, "PATCH", { token: "stolen" }],
  [`/api/accounts/${target}`, "DELETE"],
])
  assert.equal((await request(path, { method, cookie: second.cookie, body })).status, 403, `${method} ${path}`);
// ...but may use it: authorised requests are not 401/403/404 (Kaggle itself rejects the dummy token, so 200 or 502 is expected).
for (const [path, method] of [
  [`/api/accounts/${target}/sync`, "POST"],
  [`/api/accounts/${target}/verify`, "POST"],
  [`/api/accounts/${target}/notebook-logs?${ref}`, "GET"],
  [`/api/accounts/${target}/notebook-logs-stream?${ref}`, "GET"],
]) {
  const status = (await request(path, { method, cookie: second.cookie })).status;
  assert.ok(![401, 403, 404].includes(status), `member may use the connection: ${method} ${path} -> ${status}`);
}
// The workspace owner may use, replace the token of, and delete a member's connection.
const memberAccount = await request("/api/accounts", {
  method: "POST",
  cookie: second.cookie,
  body: { label: "member", username: "member", token: "member-token" },
});
assert.equal(memberAccount.status, 201);
const ownerView = (await request("/api/accounts", { cookie: login.cookie })).body.find(
  (account) => account.id === memberAccount.body.id,
);
assert.equal(ownerView.mine, false);
assert.equal(ownerView.can_delete, true);
assert.equal(ownerView.creator, "Second");
assert.notEqual(
  (await request(`/api/accounts/${memberAccount.body.id}/sync`, { method: "POST", cookie: login.cookie })).status,
  403,
);
assert.equal(
  (
    await request(`/api/accounts/${memberAccount.body.id}/credential`, {
      method: "PATCH",
      cookie: login.cookie,
      body: { token: "rotated-by-owner" },
    })
  ).status,
  200,
);
assert.equal(
  (await request(`/api/accounts/${memberAccount.body.id}`, { method: "DELETE", cookie: login.cookie })).status,
  204,
);
// A removed member falls back to their own workspace and loses access.
assert.equal(
  (
    await request("/api/auth/organization/remove-member", {
      method: "POST",
      cookie: login.cookie,
      body: { memberIdOrEmail: users[1].email, organizationId: workspace.id },
    })
  ).status,
  200,
);
assert.notEqual((await request("/api/workspace", { cookie: second.cookie })).body.id, workspace.id);
assert.equal((await request("/api/accounts", { cookie: second.cookie })).body.length, 0);
assert.equal((await request(`/api/accounts/${target}/notebook-logs?${ref}`, { cookie: second.cookie })).status, 404);
console.log("Authentication, ownership, legacy migration, CSRF and workspace sharing checks passed.");

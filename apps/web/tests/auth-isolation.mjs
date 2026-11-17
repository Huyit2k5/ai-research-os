// Run only against a disposable test database and the test server on port 3002.
import assert from "node:assert/strict";
const base = process.env.AUTH_TEST_BASE;
if (base !== "http://localhost:3002") throw new Error("Set AUTH_TEST_BASE=http://localhost:3002 for a disposable test instance.");
const users = [{ email: "first@example.test", password: "first-test-password-2026", name: "First" }, { email: "second@example.test", password: "second-test-password-2026", name: "Second" }];
async function request(path, { method = "GET", body, cookie, origin = base } = {}) {
  const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookie: cookies };
}
assert.equal((await request("/api/accounts")).status, 401);
const first = await request("/api/auth/sign-up/email", { method: "POST", body: users[0] });
const second = await request("/api/auth/sign-up/email", { method: "POST", body: users[1] });
assert.equal(first.status, 200); assert.equal(second.status, 200);
assert.ok(first.cookie && second.cookie);
const firstAccounts = await request("/api/accounts", { cookie: first.cookie });
assert.equal(firstAccounts.body.length, 1); // seeded pre-auth account is assigned to first user
assert.equal((await request("/api/accounts", { cookie: second.cookie })).body.length, 0);
assert.equal((await request(`/api/accounts/${firstAccounts.body[0].id}/notebook-logs?ref=owner%2Fnotebook`, { cookie: second.cookie })).status, 404);
const created = await request("/api/accounts", { method: "POST", cookie: first.cookie, body: { label: "demo", username: "demo", token: "dummy-token" } });
assert.equal(created.status, 201); assert.equal("credential" in created.body, false);
assert.equal((await request(`/api/accounts/${created.body.id}`, { method: "DELETE", cookie: second.cookie })).status, 404);
assert.equal((await request(`/api/accounts/${created.body.id}`, { method: "DELETE", cookie: first.cookie, origin: "https://untrusted.invalid" })).status, 403);
assert.equal((await request("/api/auth/sign-out", { method: "POST", cookie: first.cookie, body: {} })).status, 200);
assert.equal((await request("/api/accounts", { cookie: first.cookie })).status, 401);
assert.notEqual((await request("/api/auth/sign-in/email", { method: "POST", body: { email: users[0].email, password: "wrong-password-2026" } })).status, 200);
const login = await request("/api/auth/sign-in/email", { method: "POST", body: { email: users[0].email, password: users[0].password } });
assert.equal(login.status, 200);
assert.equal((await request("/api/accounts", { cookie: login.cookie })).body.length, 2);
console.log("Authentication, ownership, legacy migration and CSRF checks passed.");

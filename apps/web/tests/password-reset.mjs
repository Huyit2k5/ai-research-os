// End-to-end check of "Quên mật khẩu". Needs a disposable database and a Mailpit SMTP sink:
//   docker run -d -p 127.0.0.1:51025:1025 -p 127.0.0.1:58025:8025 axllent/mailpit
//   server env: SMTP_URL=smtp://127.0.0.1:51025 MAIL_FROM="Research OS <noreply@test.local>"
//   RESET_TEST_BASE=http://localhost:3003 MAILPIT_API=http://127.0.0.1:58025 node tests/password-reset.mjs
const base = process.env.RESET_TEST_BASE || "http://localhost:3003",
  mailpit = process.env.MAILPIT_API || "http://127.0.0.1:58025";
let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};
const post = (path, body, cookie) =>
  fetch(`${base}/api/auth${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (r) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const session = async (cookie) =>
  (await (await fetch(`${base}/api/auth/get-session`, { headers: { Cookie: cookie } })).json())?.user?.email;

const email = `reset-${Date.now()}@test.local`,
  oldPw = "old-password-12345",
  newPw = "new-password-67890";
await fetch(`${mailpit}/api/v1/messages`, { method: "DELETE" });
const signup = await post("/sign-up/email", { name: "Người <Thử>", email, password: oldPw });
check(signup.ok, "sign up");
const oldCookie = cookieOf(signup);
check((await session(oldCookie)) === email, "old session works");

const unknown = await post("/request-password-reset", {
  email: `nobody-${Date.now()}@test.local`,
  redirectTo: "/?reset=1",
});
check(unknown.ok, "unknown email gets the same success answer (no account enumeration)");
const evil = await post("/request-password-reset", { email, redirectTo: "https://evil.example/steal" });
check(!evil.ok, "foreign redirectTo is rejected");
const req = await post("/request-password-reset", { email, redirectTo: "/?reset=1" });
check(req.ok, "request reset");

let msg;
for (let i = 0; i < 20 && !msg; i++) {
  const list = await (await fetch(`${mailpit}/api/v1/messages`)).json();
  msg = list.messages?.find((m) => m.To?.some((t) => t.Address === email));
  if (!msg) await new Promise((r) => setTimeout(r, 250));
}
check(Boolean(msg), "reset email delivered");
const full = await (await fetch(`${mailpit}/api/v1/message/${msg.ID}`)).json();
check(full.Subject === "Đặt lại mật khẩu Research OS", "subject");
check(full.HTML.includes("Người &#60;Thử&#62;") && !full.HTML.includes("<Thử>"), "name is HTML-escaped");
const link = full.Text.match(/https?:\/\/\S+\/reset-password\/\S+/)?.[0];
check(Boolean(link?.startsWith(`${base}/api/auth/reset-password/`)), "link points at this server");
check(
  (await fetch(`${mailpit}/api/v1/messages`).then((r) => r.json())).messages.every(
    (m) => !m.To?.some((t) => t.Address.startsWith("nobody-")),
  ),
  "no email for the unknown address",
);

const hop = await fetch(link, { redirect: "manual" }),
  loc = new URL(hop.headers.get("location") || "", base);
check(
  hop.status === 302 &&
    loc.pathname === "/" &&
    loc.searchParams.get("reset") === "1" &&
    Boolean(loc.searchParams.get("token")),
  "link redirects to /?reset=1&token=…",
);
const token = loc.searchParams.get("token");

check(!(await post("/reset-password", { newPassword: "short", token })).ok, "too-short password rejected");
check(!(await post("/reset-password", { newPassword: newPw, token: "not-a-token" })).ok, "bad token rejected");
check((await post("/reset-password", { newPassword: newPw, token })).ok, "reset with token");
check(!(await post("/reset-password", { newPassword: "another-password-1", token })).ok, "token is single-use");
check((await session(oldCookie)) !== email, "old session revoked");
check(!(await post("/sign-in/email", { email, password: oldPw })).ok, "old password no longer works");
check((await post("/sign-in/email", { email, password: newPw })).ok, "new password works");

const expired = await fetch(`${base}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/?reset=1")}`, {
  redirect: "manual",
});
check(
  new URL(expired.headers.get("location") || "", base).searchParams.get("error") === "INVALID_TOKEN",
  "used link redirects with error=INVALID_TOKEN",
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

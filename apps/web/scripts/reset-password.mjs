// Sets a new password for an existing email+password user and signs them out everywhere (there is no reset-by-email flow).
// Usage, inside apps/web: node --env-file=.env.local scripts/reset-password.mjs you@example.com
import pg from "pg";
import { hashPassword, verifyPassword } from "better-auth/crypto";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email || !process.env.DATABASE_URL) {
  console.error("Cách dùng: node --env-file=.env.local scripts/reset-password.mjs <email> (cần DATABASE_URL)");
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => resolve(s.split(/\r?\n/)[0]));
      return;
    }
    process.stdout.write(prompt);
    let s = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("Đã hủy."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(s);
          return;
        }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else s += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const user = (await db.query(`SELECT id, name FROM "user" WHERE lower(email)=$1`, [email])).rows[0];
  if (!user) throw new Error(`Không có tài khoản với email ${email}.`);
  const account = (await db.query(`SELECT id FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [user.id]))
    .rows[0];
  if (!account) throw new Error("Tài khoản này không đăng nhập bằng mật khẩu.");
  const password = await ask("Mật khẩu mới (12–128 ký tự, không hiện khi gõ): ");
  if (password.length < 12 || password.length > 128) throw new Error("Mật khẩu phải dài 12–128 ký tự.");
  if (process.stdin.isTTY && (await ask("Nhập lại: ")) !== password) throw new Error("Hai lần nhập không khớp.");
  const hash = await hashPassword(password);
  if (!(await verifyPassword({ hash, password }))) throw new Error("Băm mật khẩu lỗi, chưa đổi gì.");
  await db.query("BEGIN");
  await db.query(`UPDATE account SET password=$1, "updatedAt"=now() WHERE id=$2`, [hash, account.id]);
  const out = await db.query(`DELETE FROM session WHERE "userId"=$1`, [user.id]);
  await db.query("COMMIT");
  console.log(`Đã đổi mật khẩu cho ${user.name} <${email}> và đăng xuất ${out.rowCount} phiên.`);
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}

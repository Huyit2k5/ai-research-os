import { betterAuth } from "better-auth";
import { createHmac } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL || !process.env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY are required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const secret = process.env.BETTER_AUTH_SECRET || createHmac("sha256", process.env.CREDENTIAL_ENCRYPTION_KEY).update("research-os-auth-v1").digest("hex");
const auth = betterAuth({ database: pool, secret, baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000", emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 } });
const lock = await pool.connect();
try {
  await lock.query("SELECT pg_advisory_lock(82645122)");
  const context = await auth.$context;
  await context.runMigrations();
  await lock.query("CREATE TABLE IF NOT EXISTS compute_accounts (id SERIAL PRIMARY KEY, label VARCHAR(100) NOT NULL, username VARCHAR(100) NOT NULL, credential TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, last_verified_at TIMESTAMPTZ)");
  await lock.query("ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES \"user\"(id)");
  await lock.query("CREATE INDEX IF NOT EXISTS compute_accounts_owner_id_idx ON compute_accounts(owner_id)");
  // Supabase exposes public tables through its Data API; RLS without policies blocks it, while this owning role bypasses RLS.
  for (const table of ["user", "session", "account", "verification", "compute_accounts"]) await lock.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
} finally {
  await lock.query("SELECT pg_advisory_unlock(82645122)");
  lock.release();
  await pool.end();
}

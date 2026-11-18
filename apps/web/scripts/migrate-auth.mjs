import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL || !process.env.CREDENTIAL_ENCRYPTION_KEY)
  throw new Error("DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY are required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const secret =
  process.env.BETTER_AUTH_SECRET ||
  createHmac("sha256", process.env.CREDENTIAL_ENCRYPTION_KEY).update("research-os-auth-v1").digest("hex");
// Plugins must match lib/auth.ts so the same tables are migrated.
const auth = betterAuth({
  database: pool,
  secret,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
  plugins: [organization()],
});
const lock = await pool.connect();
try {
  await lock.query("SELECT pg_advisory_lock(82645122)");
  const context = await auth.$context;
  await context.runMigrations();
  await lock.query(
    "CREATE TABLE IF NOT EXISTS compute_accounts (id SERIAL PRIMARY KEY, label VARCHAR(100) NOT NULL, username VARCHAR(100) NOT NULL, credential TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, last_verified_at TIMESTAMPTZ)",
  );
  await lock.query('ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES "user"(id)');
  await lock.query("CREATE INDEX IF NOT EXISTS compute_accounts_owner_id_idx ON compute_accounts(owner_id)");
  await lock.query(
    "ALTER TABLE compute_accounts ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE",
  );
  await lock.query("CREATE INDEX IF NOT EXISTS compute_accounts_workspace_id_idx ON compute_accounts(workspace_id)");
  // Connections created before workspaces move into a personal workspace of their creator.
  for (const { owner_id } of (
    await lock.query(
      "SELECT DISTINCT owner_id FROM compute_accounts WHERE workspace_id IS NULL AND owner_id IS NOT NULL",
    )
  ).rows) {
    const workspace = await auth.api.createOrganization({
      body: { name: "Cá nhân", slug: `ca-nhan-${randomUUID()}`, userId: owner_id },
    });
    await lock.query("UPDATE compute_accounts SET workspace_id=$1 WHERE owner_id=$2 AND workspace_id IS NULL", [
      workspace.id,
      owner_id,
    ]);
  }
  await lock.query(
    `CREATE TABLE IF NOT EXISTS account_sync (account_id INTEGER PRIMARY KEY REFERENCES compute_accounts(id) ON DELETE CASCADE, synced_at TIMESTAMPTZ NOT NULL, quota JSONB, notebooks JSONB, notebooks_truncated BOOLEAN NOT NULL DEFAULT FALSE, errors JSONB NOT NULL DEFAULT '{}'::jsonb); CREATE TABLE IF NOT EXISTS quota_snapshots (id BIGSERIAL PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES compute_accounts(id) ON DELETE CASCADE, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), quota JSONB NOT NULL); CREATE INDEX IF NOT EXISTS quota_snapshots_account_idx ON quota_snapshots(account_id, captured_at DESC); ALTER TABLE account_sync ENABLE ROW LEVEL SECURITY; ALTER TABLE quota_snapshots ENABLE ROW LEVEL SECURITY`,
  );
  // Supabase exposes public tables through its Data API; RLS without policies blocks it, while this owning role bypasses RLS.
  for (const table of [
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "member",
    "invitation",
    "compute_accounts",
  ])
    await lock.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
} finally {
  await lock.query("SELECT pg_advisory_unlock(82645122)");
  lock.release();
  await pool.end();
}

import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
const globalPool = globalThis as typeof globalThis & { researchPool?: Pool };
export const db = globalPool.researchPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
let initialized: Promise<unknown> | undefined;
// RLS with no policies blocks Supabase's public Data API (anon/authenticated); the owning role used here bypasses it.
export function initialize() {
  initialized ??= db.query(`CREATE TABLE IF NOT EXISTS compute_accounts (id SERIAL PRIMARY KEY, label VARCHAR(100) NOT NULL, username VARCHAR(100) NOT NULL, credential TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, last_verified_at TIMESTAMPTZ); ALTER TABLE compute_accounts ENABLE ROW LEVEL SECURITY` ).catch(err => { initialized = undefined; throw err; });
  return initialized;
}
function keyBytes() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new AppError(503, "Chưa cấu hình khóa mã hóa trên server.");
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new AppError(503, "Khóa mã hóa không hợp lệ.");
  return key;
}
// Fernet-compatible encoding preserves tokens written by the former Python backend.
export function encryptToken(value: string) {
  const key = keyBytes(), iv = randomBytes(16), header = Buffer.alloc(9);
  header[0] = 0x80; header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const cipher = createCipheriv("aes-128-cbc", key.subarray(16), iv);
  const payload = Buffer.concat([header, iv, cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([payload, createHmac("sha256", key.subarray(0, 16)).update(payload).digest()]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
export function decryptToken(encoded: string) {
  try {
    const key = keyBytes(), token = Buffer.from(encoded, "base64url");
    if (token.length < 73 || token[0] !== 0x80) throw new Error();
    const payload = token.subarray(0, -32), mac = token.subarray(-32);
    const expected = createHmac("sha256", key.subarray(0, 16)).update(payload).digest();
    if (!timingSafeEqual(mac, expected)) throw new Error();
    const decipher = createDecipheriv("aes-128-cbc", key.subarray(16), payload.subarray(9, 25));
    return Buffer.concat([decipher.update(payload.subarray(25)), decipher.final()]).toString("utf8");
  } catch { throw new AppError(503, "Không thể giải mã token. Kiểm tra khóa mã hóa."); }
}
export async function accountById(id: string, ownerId: string) {
  if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(404, "Không tìm thấy kết nối.");
  await initialize();
  const result = await db.query("SELECT * FROM compute_accounts WHERE id=$1 AND owner_id=$2", [id, ownerId]);
  if (!result.rows.length) throw new AppError(404, "Không tìm thấy kết nối.");
  return result.rows[0];
}
// These methods mirror the official Kaggle SDK; credentials never enter URLs or logs.
export async function kaggleCall(token: string, method: string, body: object): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`https://api.kaggle.com/v1/kernels.KernelsApiService/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error();
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new AppError(502, "Kaggle không trả dữ liệu. Kiểm tra token, quyền truy cập và kết nối mạng."); }
}
export function normalizeQuota(data: Record<string, unknown>) {
  return ([["GPU", data.gpuQuota], ["TPU", data.tpuQuota]] as const).flatMap(([resource, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const quota = raw as Record<string, unknown>;
    const hours = (v: unknown) => { if (typeof v !== "string" || !/^\d+(?:\.\d+)?s$/.test(v)) throw new AppError(502, "Kaggle trả quota không đúng định dạng."); return Number(v.slice(0, -1)) / 3600; };
    const used = hours(quota.timeUsed ?? "0s"), total = hours(quota.totalTimeAllowed);
    return [{ resource, used: `${used.toFixed(2)}h`, remaining: `${Math.max(0, total - used).toFixed(2)}h`, total: `${total.toFixed(2)}h`, refreshAt: data.quotaRefreshTime ?? "" }];
  });
}

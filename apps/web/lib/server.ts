import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
const globalPool = globalThis as typeof globalThis & { researchPool?: Pool };
export const db = globalPool.researchPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
let initialized: Promise<unknown> | undefined;
export function initialize() {
  initialized ??= db.query(`CREATE TABLE IF NOT EXISTS compute_accounts (id SERIAL PRIMARY KEY, label VARCHAR(100) NOT NULL, username VARCHAR(100) NOT NULL, credential TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, last_verified_at TIMESTAMPTZ)` ).catch(err => { initialized = undefined; throw err; });
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
export async function accountById(id: string) {
  if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(404, "Không tìm thấy kết nối.");
  await initialize();
  const result = await db.query("SELECT * FROM compute_accounts WHERE id=$1", [id]);
  if (!result.rows.length) throw new AppError(404, "Không tìm thấy kết nối.");
  return result.rows[0];
}
export async function startKaggle(token: string, args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "research-os-kaggle-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KAGGLE_"))) as NodeJS.ProcessEnv;
  Object.assign(env, { KAGGLE_API_TOKEN: token, KAGGLE_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir, PYTHONUNBUFFERED: "1" });
  const child = spawn(process.env.KAGGLE_PYTHON || "python3", ["-u", "-m", "kaggle", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  return { child, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}
export async function runKaggle(token: string, args: string[], maxBytes = 1024 * 1024) {
  const { child, cleanup } = await startKaggle(token, args);
  return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
    let chunks: Buffer[] = [], size = 0, settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new AppError(502, "Yêu cầu Kaggle quá thời gian.")); }, 45000);
    function finish(error?: Error) { if (settled) return; settled = true; clearTimeout(timer); void cleanup(); if (error) reject(error); else resolve({ text: Buffer.concat(chunks).subarray(-maxBytes).toString("utf8").trim(), truncated: size > maxBytes }); }
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; chunks.push(chunk); while (chunks.length > 1 && chunks.reduce((n, b) => n + b.length, 0) - chunks[0].length >= maxBytes) chunks.shift(); if (chunks.length === 1 && chunks[0].length > maxBytes) chunks[0] = chunks[0].subarray(-maxBytes); });
    child.stderr.resume(); child.on("error", () => finish(new AppError(502, "Không thể chạy Kaggle CLI.")));
    child.on("close", code => finish(code === 0 ? undefined : new AppError(502, "Kaggle không trả dữ liệu. Kiểm tra token, quyền truy cập và kết nối mạng.")));
  });
}
export function parseResults(text: string) {
  if (text === "Not found" || text === "No quota information available") return { data: [], truncated: false };
  const truncated = text.startsWith("Next Page Token = ");
  try { const data: unknown = JSON.parse(truncated ? text.slice(text.indexOf("\n") + 1) : text); if (!Array.isArray(data)) throw new Error(); return { data, truncated }; }
  catch { throw new AppError(502, "Kaggle trả về dữ liệu không đúng định dạng."); }
}

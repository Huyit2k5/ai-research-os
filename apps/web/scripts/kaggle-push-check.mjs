// Pushes a tiny CPU script to Kaggle with SaveKernel through a stored connection and prints what Kaggle answers.
// Usage, inside apps/web: node --env-file=.env.local scripts/kaggle-push-check.mjs <account_id> [owner/slug]
// Optional third argument: a dataset (owner/slug) to attach as datasetDataSources.
// Without a ref it creates the private notebook "ros push check"; with one it pushes a new version to it and sends no source lists.
// The decrypted token is only used in the Authorization header and is never printed.
import pg from "pg";
import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

const [accountId, ref, dataset] = process.argv.slice(2);
if (!/^\d+$/.test(accountId || "") || !process.env.DATABASE_URL || !process.env.CREDENTIAL_ENCRYPTION_KEY) {
  console.error("Cách dùng: node --env-file=.env.local scripts/kaggle-push-check.mjs <account_id> [owner/slug]");
  process.exit(1);
}

function decrypt(encoded) {
  // same Fernet layout as lib/server.ts decryptToken
  const key = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY, "base64url"),
    token = Buffer.from(encoded, "base64url");
  const payload = token.subarray(0, -32),
    mac = createHmac("sha256", key.subarray(0, 16)).update(payload).digest();
  if (token[0] !== 0x80 || !timingSafeEqual(token.subarray(-32), mac))
    throw new Error("Không giải mã được token (sai khóa).");
  const d = createDecipheriv("aes-128-cbc", key.subarray(16), payload.subarray(9, 25));
  return Buffer.concat([d.update(payload.subarray(25)), d.final()]).toString("utf8");
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const row = (await db.query("SELECT username, credential FROM compute_accounts WHERE id=$1", [accountId])).rows[0];
await db.end();
if (!row) {
  console.error("Không có kết nối này.");
  process.exit(1);
}
const token = decrypt(row.credential);
const call = async (method, body) => {
  const r = await fetch(`https://api.kaggle.com/v1/kernels.KernelsApiService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 500);
  }
  return { status: r.status, data };
};
const show = (label, v) =>
  console.log(
    label,
    JSON.stringify(
      v,
      (k, x) =>
        /token|credential|blob/i.test(k)
          ? "[omitted]"
          : typeof x === "string" && x.length > 300
            ? x.slice(0, 300) + "…"
            : x,
      2,
    ),
  );

const body = {
  text: `print('ros push check ok', ${Date.now()})`,
  language: "python",
  kernelType: "script",
  isPrivate: true,
  enableGpu: false,
  enableInternet: false,
  kernelExecutionType: "SaveAndRunAll",
  ...(ref ? { slug: ref } : { newTitle: "ros push check" }),
  ...(dataset ? { datasetDataSources: [dataset] } : {}),
};
const saved = await call("SaveKernel", body);
show("SaveKernel", saved);
const savedRef =
  typeof saved.data?.ref === "string" ? saved.data.ref.replace(/^\/?code\//, "").replace(/^\//, "") : ref;
if (saved.status !== 200 || !savedRef) process.exit(1);
const [userName, kernelSlug] = savedRef.split("/");
for (let i = 0; i < 60; i++) {
  const s = await call("GetKernelSessionStatus", { userName, kernelSlug });
  const status = String(s.data?.status ?? "");
  console.log("status", s.status, status, s.data?.failureMessage ?? "");
  if (/COMPLETE|ERROR|CANCEL/i.test(status)) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const k = await call("GetKernel", { userName, kernelSlug });
show("GetKernel.metadata", k.data?.metadata);
console.log("GetKernel.blob.source", JSON.stringify(k.data?.blob?.source)?.slice(0, 200));

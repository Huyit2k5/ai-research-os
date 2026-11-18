// Checks that the S3-compatible store behind S3_* env vars supports what the documents module needs:
// presigned PUT bound to type + length, HEAD, presigned GET with response-content-* overrides, browser CORS, DELETE.
// Usage: node --env-file=.env.local scripts/storage-check.mjs [--origin http://localhost:3001] [--create-bucket]
import { AwsClient } from "aws4fetch";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Thiếu biến ${k}`);
  return v;
};
const bucket = env("S3_BUCKET"),
  endpoint = env("S3_ENDPOINT")
    .replace(/\/+$/, "")
    .replace(new RegExp(`/${bucket}$`), "");
const aws = new AwsClient({
  accessKeyId: env("S3_ACCESS_KEY_ID"),
  secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
  service: "s3",
  region: env("S3_REGION"),
});
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const origin = arg("--origin") ?? "http://localhost:3001";
const url = (key, query = {}) => {
  const u = new URL(`${endpoint}/${bucket}/${key}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
};
const presign = async (method, u, headers = {}, expires = 600) => {
  const x = new URL(u);
  x.searchParams.set("X-Amz-Expires", String(expires));
  return (await aws.sign(x.toString(), { method, headers, aws: { signQuery: true, allHeaders: true } })).url;
};

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log("  ✓", name);
  } catch (e) {
    failed++;
    console.log("  ✗", name, "—", e instanceof Error ? e.message : e);
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

if (process.argv.includes("--create-bucket")) {
  const r = await aws.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
  if (!r.ok && r.status !== 409) throw new Error(`Không tạo được bucket: ${r.status} ${await r.text()}`);
}

const key = `storage-check/${Date.now()}`,
  body = new Uint8Array(1024).fill(65),
  type = "application/pdf";
console.log(`Storage check: ${endpoint} bucket=${bucket} origin=${origin}`);
await check("presigned PUT bound to Content-Type + Content-Length uploads 1 KB", async () => {
  const r = await fetch(
    await presign("PUT", url(key), { "content-type": type, "content-length": String(body.length) }),
    { method: "PUT", headers: { "content-type": type }, body },
  );
  expect(r.ok, `${r.status} ${await r.text()}`);
});
await check("presigned PUT rejects a body of a different length", async () => {
  const r = await fetch(await presign("PUT", url(`${key}-len`), { "content-type": type, "content-length": "1024" }), {
    method: "PUT",
    headers: { "content-type": type },
    body: new Uint8Array(2048),
  });
  expect(!r.ok, `accepted with status ${r.status}`);
});
await check("HEAD returns size and type", async () => {
  const r = await aws.fetch(url(key), { method: "HEAD" });
  expect(r.ok, `status ${r.status}`);
  expect(r.headers.get("content-length") === "1024", `size ${r.headers.get("content-length")}`);
  expect(r.headers.get("content-type") === type, `type ${r.headers.get("content-type")}`);
});
await check("presigned GET applies response-content-disposition and response-content-type", async () => {
  const disposition = `attachment; filename="Bao.pdf"; filename*=UTF-8''B%C3%A1o.pdf`;
  const r = await fetch(
    await presign(
      "GET",
      url(key, { "response-content-disposition": disposition, "response-content-type": "application/pdf" }),
      {},
      300,
    ),
  );
  expect(r.ok, `status ${r.status}`);
  expect(r.headers.get("content-disposition") === disposition, `disposition ${r.headers.get("content-disposition")}`);
  expect(r.headers.get("content-type") === "application/pdf", `type ${r.headers.get("content-type")}`);
  expect((await r.arrayBuffer()).byteLength === 1024, "wrong body");
});
await check(`CORS preflight allows PUT from ${origin}`, async () => {
  const r = await fetch(url(key), {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allow = r.headers.get("access-control-allow-origin");
  expect(r.ok && (allow === origin || allow === "*"), `status ${r.status}, allow-origin ${allow}`);
});
await check("DELETE removes the object", async () => {
  const d = await aws.fetch(url(key), { method: "DELETE" });
  expect(d.ok || d.status === 204, `status ${d.status}`);
  const h = await aws.fetch(url(key), { method: "HEAD" });
  expect(h.status === 404, `still there: ${h.status}`);
});
await aws.fetch(url(`${key}-len`), { method: "DELETE" }).catch(() => {});
console.log(failed ? `${failed} check(s) failed.` : "All storage checks passed.");
process.exit(failed ? 1 : 0);

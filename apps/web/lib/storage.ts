import "server-only";
import { AwsClient } from "aws4fetch";
import { AppError } from "./server";

/**
 * S3-protocol object store (Cloudflare R2 in production, MinIO in tests). File bytes never pass through the app:
 * the browser PUTs to a presigned URL and reads from a presigned GET. Changing provider only means changing S3_* env vars.
 */
const VARS = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
export const storageConfigured = () => VARS.every((k) => !!process.env[k]);
function client() {
  if (!storageConfigured())
    throw new AppError(
      503,
      "Chưa cấu hình kho file (S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).",
    );
  const bucket = process.env.S3_BUCKET!;
  // Cloudflare shows the bucket URL (…r2.cloudflarestorage.com/<bucket>); accept both that and the bare account endpoint.
  const endpoint = process.env
    .S3_ENDPOINT!.replace(/\/+$/, "")
    .replace(new RegExp(`/${bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
  return {
    aws: new AwsClient({
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      service: "s3",
      region: process.env.S3_REGION!,
    }),
    base: `${endpoint}/${bucket}`,
  };
}
const objectUrl = (base: string, key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
// aws4fetch skips content-type/length by default; allHeaders binds them so a PUT cannot exceed the declared size.
async function presign(method: "PUT" | "GET", url: string, expires: number, headers: Record<string, string> = {}) {
  const { aws } = client(),
    u = new URL(url);
  u.searchParams.set("X-Amz-Expires", String(expires));
  return (await aws.sign(u.toString(), { method, headers, aws: { signQuery: true, allHeaders: true } })).url;
}

export async function presignPut(key: string, contentType: string, size: number) {
  const headers = { "content-type": contentType, "content-length": String(size) };
  return {
    url: await presign("PUT", objectUrl(client().base, key), 600, headers),
    headers: { "content-type": contentType },
  };
}

/** RFC 6266/5987 disposition: ASCII fallback plus UTF-8 filename* so Vietnamese names survive. */
export function contentDisposition(fileName: string, inline: boolean) {
  const ascii = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function presignGet(key: string, o: { fileName: string; contentType: string; inline: boolean }) {
  const u = new URL(objectUrl(client().base, key));
  u.searchParams.set("response-content-disposition", contentDisposition(o.fileName, o.inline));
  u.searchParams.set("response-content-type", o.contentType);
  return presign("GET", u.toString(), 300);
}

export async function headObject(key: string): Promise<{ size: number; contentType: string } | null> {
  const { aws, base } = client(),
    r = await aws.fetch(objectUrl(base, key), { method: "HEAD" });
  if (r.status === 404) return null;
  if (!r.ok) throw new AppError(502, "Kho file không phản hồi. Vui lòng thử lại.");
  return {
    size: Number(r.headers.get("content-length") ?? -1),
    contentType: (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
  };
}

export async function deleteObject(key: string) {
  const { aws, base } = client(),
    r = await aws.fetch(objectUrl(base, key), { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
}

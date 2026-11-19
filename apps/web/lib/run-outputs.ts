import "server-only";
import { AppError, db, decryptToken, kaggleCall } from "./server";
import { getRun, OUTPUT_HOST } from "./experiments";
import type { Scope } from "./workspace";

/** Kaggle lists name + an anonymous download URL per file; it gives no size. */
export type OutputFile = { name: string; url: string };
const MAX_PAGES = 20;

/** Output files of a Kaggle run's version (latest when the run has no version). Any workspace member. */
export async function listRunOutputs(s: Scope, idRaw: unknown): Promise<{ files: OutputFile[]; truncated: boolean }> {
  const run = await getRun(s, idRaw);
  const ref = typeof run.ref === "string" ? run.ref : "",
    version = Number(run.version) || null;
  if (run.source !== "kaggle" || !run.account_id || !ref) {
    throw new AppError(422, "Run này không gắn với notebook Kaggle nào.");
  }
  const account = (
    await db.query("SELECT credential FROM compute_accounts WHERE id=$1 AND workspace_id=$2", [
      run.account_id,
      s.workspaceId,
    ])
  ).rows[0];
  if (!account) throw new AppError(404, "Không tìm thấy kết nối Kaggle của run này.");
  const [userName, kernelSlug] = ref.split("/");
  const req = { userName, kernelSlug, ...(version ? { versionLabel: `v${version}` } : {}) };
  const token = decryptToken(account.credential);
  const files: OutputFile[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await kaggleCall(token, "ListKernelSessionOutput", pageToken ? { ...req, pageToken } : req);
    for (const f of Array.isArray(page.files) ? page.files : []) {
      if (f && typeof f.fileName === "string" && typeof f.url === "string")
        files.push({ name: f.fileName, url: f.url });
    }
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    if (!pageToken) break;
  }
  return { files, truncated: !!pageToken };
}

/** Streams one listed file back as an attachment. Only names Kaggle listed are fetched, and only from Kaggle/Google hosts.
 *  shortcut: bytes pass through the app (Kaggle sends no CORS or Content-Disposition); very large files are better
 *  fetched with the copied curl command. */
export async function downloadRunOutput(s: Scope, idRaw: unknown, nameRaw: unknown): Promise<Response> {
  const name = typeof nameRaw === "string" ? nameRaw : "";
  if (!name) throw new AppError(422, "Thiếu tên file.");
  const file = (await listRunOutputs(s, idRaw)).files.find((f) => f.name === name);
  if (!file) throw new AppError(404, "Không có file này trong output của run.");
  const u = new URL(file.url);
  if (u.protocol !== "https:" || !OUTPUT_HOST.test(u.hostname))
    throw new AppError(502, "Link file không phải của Kaggle.");
  const r = await fetch(u, { cache: "no-store" }).catch(() => null);
  if (!r || !r.ok || !r.body || !OUTPUT_HOST.test(new URL(r.url).hostname)) {
    throw new AppError(502, "Kaggle không trả file.");
  }
  const base = name.split("/").pop() || "output";
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const length = r.headers.get("content-length");
  if (length) headers["Content-Length"] = length;
  return new Response(r.body, { headers });
}

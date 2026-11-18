import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { startUpload } from "../../../../lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await startUpload(s, s.viaToken ? "api" : "web", body as Record<string, unknown>));
  } catch (e) {
    return fail(e);
  }
}

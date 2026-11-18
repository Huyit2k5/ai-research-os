import { AppError } from "../../../lib/server";
import { fail, json, owner } from "../../../lib/papers";
import { createTextDoc, listDocs } from "../../../lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req, { allowToken: true }),
      sp = new URL(req.url).searchParams,
      v = (k: string) => sp.get(k) || undefined;
    return json(
      await listDocs(s, {
        q: sp.get("q") || "",
        kind: v("kind"),
        status: v("status"),
        tag: v("tag"),
        limit: Number(sp.get("limit")) || 50,
        offset: Number(sp.get("offset")) || 0,
      }),
    );
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await createTextDoc(s, s.viaToken ? "api" : "web", body as Record<string, unknown>), 201);
  } catch (e) {
    return fail(e);
  }
}

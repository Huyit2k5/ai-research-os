import { AppError } from "../../../lib/server";
import { fail, json, owner } from "../../../lib/papers";
import { createRequest, listRequests } from "../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req, { allowToken: true }), q = new URL(req.url).searchParams, idea = q.get("idea_id");
    return json(await listRequests(s, { status: q.get("status") || undefined, idea_id: idea ? Number(idea) || -1 : undefined, limit: Number(q.get("limit")) || undefined, offset: Number(q.get("offset")) || undefined }));
  } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await createRequest(s, s.viaToken ? "api" : "web", body as Record<string, unknown>), 201);
  } catch (e) { return fail(e); }
}

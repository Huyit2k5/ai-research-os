import { AppError } from "../../../lib/server";
import { fail, json, owner } from "../../../lib/papers";
import { listRuns, logManualRun } from "../../../lib/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const scope = await owner(req), sp = new URL(req.url).searchParams, s = (k: string) => sp.get(k) || undefined;
    return json(await listRuns(scope, { q: sp.get("q") || "", ref: s("ref"), tag: s("tag"), status: s("status"), source: s("source"), account: Number(sp.get("account")) || undefined, sort: s("sort"), metric: s("metric"), order: s("order"), limit: Number(sp.get("limit")) || 50, offset: Number(sp.get("offset")) || 0 }));
  } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await logManualRun(s, body as Record<string, unknown>), 201);
  } catch (e) { return fail(e); }
}

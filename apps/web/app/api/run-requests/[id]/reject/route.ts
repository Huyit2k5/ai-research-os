import { fail, json, owner } from "../../../../../lib/papers";
import { rejectRequest } from "../../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Session only: a personal token (the AI) can never review a request. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), body = await req.json().catch(() => ({})) as Record<string, unknown> | null;
    return json(await rejectRequest(s, (await params).id, body?.note));
  } catch (e) { return fail(e); }
}

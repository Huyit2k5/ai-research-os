import { fail, json, owner } from "../../../../../lib/papers";
import { approveRequest } from "../../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Session only: approving spends GPU, so a personal token (the AI) can never do it. Body `{ save_only: true }` = Quick Save. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req);
    const body = (await req.json().catch(() => null)) as { save_only?: unknown } | null;
    return json(await approveRequest(s, (await params).id, { saveOnly: body?.save_only === true }));
  } catch (e) {
    return fail(e);
  }
}

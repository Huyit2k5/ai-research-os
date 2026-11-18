import { fail, json, owner } from "../../../../../lib/papers";
import { approveRequest } from "../../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Session only: approving spends GPU, so a personal token (the AI) can never do it. */
export async function POST(req: Request, { params }: Ctx) {
  try { return json(await approveRequest(await owner(req), (await params).id)); } catch (e) { return fail(e); }
}

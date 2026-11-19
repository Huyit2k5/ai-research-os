import { fail, json, owner, rateLimit } from "../../../../../lib/papers";
import { listRunOutputs } from "../../../../../lib/run-outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req);
    await rateLimit(s.userId, "run-outputs", 60, 60);
    return json(await listRunOutputs(s, (await params).id));
  } catch (e) {
    return fail(e);
  }
}

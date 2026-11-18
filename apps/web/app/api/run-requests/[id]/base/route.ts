import { fail, json, owner } from "../../../../../lib/papers";
import { currentSource } from "../../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  try {
    return json(await currentSource(await owner(req, { allowToken: true }), (await params).id));
  } catch (e) {
    return fail(e);
  }
}

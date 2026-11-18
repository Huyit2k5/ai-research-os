import { fail, json, owner } from "../../../../../lib/papers";
import { cancelRequest } from "../../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  try {
    return json(await cancelRequest(await owner(req, { allowToken: true }), (await params).id));
  } catch (e) {
    return fail(e);
  }
}

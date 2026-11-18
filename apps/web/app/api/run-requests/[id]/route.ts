import { fail, json, owner } from "../../../../lib/papers";
import { getRequest } from "../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req, { allowToken: true }),
      code = new URL(req.url).searchParams.get("code");
    return json(await getRequest(s, (await params).id, { withCode: code === "1" || code === "true" }));
  } catch (e) {
    return fail(e);
  }
}

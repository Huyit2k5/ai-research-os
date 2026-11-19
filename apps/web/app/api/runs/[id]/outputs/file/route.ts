import { fail, owner, rateLimit } from "../../../../../../lib/papers";
import { downloadRunOutput } from "../../../../../../lib/run-outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** ?name=<file name as listed>; streams the file as an attachment. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req);
    // selecting many files downloads them one by one
    await rateLimit(s.userId, "run-output-file", 300, 60);
    return await downloadRunOutput(s, (await params).id, new URL(req.url).searchParams.get("name"));
  } catch (e) {
    return fail(e);
  }
}

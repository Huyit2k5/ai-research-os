import { fail, json, owner } from "../../../../lib/papers";
import { compareRuns } from "../../../../lib/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req), ids = (new URL(req.url).searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
    return json(await compareRuns(s, ids));
  } catch (e) { return fail(e); }
}

import { fail, json, mergePapers, owner } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Body: { keep_id: number, merge_ids: number[] }. The merged papers are deleted after their notes and tags move to keep_id.
export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = await req.json().catch(() => null);
    return json(await mergePapers(s, body?.keep_id, body?.merge_ids));
  } catch (e) { return fail(e); }
}

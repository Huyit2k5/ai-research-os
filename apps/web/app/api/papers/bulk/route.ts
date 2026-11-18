import { bulkPapers, fail, json, owner } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Body: { ids: number[], action: "delete" | "status" | "add_tag" | "remove_tag", value?: string }
export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = await req.json().catch(() => null);
    return json(await bulkPapers(s, body?.ids, body?.action, body?.value));
  } catch (e) { return fail(e); }
}

import { fail, json, owner, rateLimit, refreshMetadata } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Body: { ids: number[] } (up to 100). Re-reads citation count, work type and missing fields from OpenAlex.
export async function POST(req: Request) {
  try {
    const s = await owner(req);
    await rateLimit(s.userId, "refresh", 30, 3600);
    const body = await req.json().catch(() => null);
    return json(await refreshMetadata(s, body?.ids));
  } catch (e) { return fail(e); }
}

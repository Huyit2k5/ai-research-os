import { fail, json, markSaved, owner, rateLimit, searchPapers } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req);
    await rateLimit(s.userId, "search", 20, 60);
    const sp = new URL(req.url).searchParams;
    const found = await searchPapers(sp.get("q") || "", Number(sp.get("limit")) || 10, {
      page: Number(sp.get("page")) || 1,
      yearFrom: Number(sp.get("year_from")) || null,
      yearTo: Number(sp.get("year_to")) || null,
    });
    return json({ ...found, results: await markSaved(s, found.results) });
  } catch (e) {
    return fail(e);
  }
}

import { fail, json, listPapers, owner, parsePaper, savePaper } from "../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req),
      sp = new URL(req.url).searchParams;
    return json(
      await listPapers(s, {
        q: sp.get("q") || "",
        sort: sp.get("sort") || "",
        source: sp.get("source") || "",
        status: sp.get("status") || "",
        readers: sp.get("readers") || "",
        tag: sp.get("tag") || "",
        limit: Number(sp.get("limit")) || 50,
        offset: Number(sp.get("offset")) || 0,
      }),
    );
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = await req.json().catch(() => null);
    const { paper, created } = await savePaper(s, parsePaper(body), "manual");
    return json({ ...paper, created }, created ? 201 : 200);
  } catch (e) {
    return fail(e);
  }
}

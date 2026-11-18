import { fail, importPaper, json, owner, rateLimit, savePaper } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Adds a paper by DOI, DOI URL, arXiv id or arXiv URL; metadata is fetched from OpenAlex / arXiv.
export async function POST(req: Request) {
  try {
    const s = await owner(req);
    await rateLimit(s.userId, "search", 20, 60);
    const body = await req.json().catch(() => null);
    const { paper, created } = await savePaper(
      s,
      await importPaper(typeof body?.identifier === "string" ? body.identifier : ""),
      "manual",
    );
    return json({ ...paper, created }, created ? 201 : 200);
  } catch (e) {
    return fail(e);
  }
}

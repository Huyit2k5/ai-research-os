import { exportBibtex, fail, owner } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/papers/export?ids=1,2 or the same filters as the list (q, source, status, tag). Returns a .bib file.
export async function GET(req: Request) {
  try {
    const s = await owner(req), sp = new URL(req.url).searchParams;
    const ids = sp.get("ids") ? sp.get("ids")!.split(",").map(Number).filter(n => Number.isInteger(n) && n > 0) : undefined;
    const { bibtex } = await exportBibtex(s, { q: sp.get("q") || "", source: sp.get("source") || "", status: sp.get("status") || "", readers: sp.get("readers") || "", tag: sp.get("tag") || "", ids });
    const inline = sp.get("inline") === "1";
    return new Response(bibtex, { headers: { "Content-Type": inline ? "text/plain; charset=utf-8" : "application/x-bibtex; charset=utf-8", "Cache-Control": "no-store", ...(inline ? {} : { "Content-Disposition": 'attachment; filename="research-os.bib"' }) } });
  } catch (e) { return fail(e); }
}

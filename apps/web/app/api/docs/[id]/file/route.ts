import { fail, json, owner } from "../../../../../lib/papers";
import { fileUrl } from "../../../../../lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Redirects to a short-lived presigned URL. ?url=1 returns it as JSON instead, so fetch() avoids a cross-origin redirect (which would send Origin: null). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const sp = new URL(req.url).searchParams,
      url = await fileUrl(await owner(req, { allowToken: true }), (await params).id, sp.get("download") === "1");
    return sp.get("url") === "1"
      ? json({ url })
      : new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}

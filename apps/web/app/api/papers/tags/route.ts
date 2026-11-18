import { fail, json, listTags, owner } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await owner(req);
    return json(await listTags(s));
  } catch (e) {
    return fail(e);
  }
}

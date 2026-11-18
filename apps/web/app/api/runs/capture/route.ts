import { AppError } from "../../../../lib/server";
import { fail, json, owner, rateLimit } from "../../../../lib/papers";
import { captureRunFor } from "../../../../lib/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const s = await owner(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    await rateLimit(s.userId, "capture", 20, 60);
    return json(await captureRunFor(s, body.account_id, body.ref, { version: body.version, force: true }));
  } catch (e) {
    return fail(e);
  }
}

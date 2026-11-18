import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { runNow } from "../../../../lib/run-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session only: the member who presses "Chạy" is the reviewer. */
export async function POST(req: Request) {
  try {
    const s = await owner(req),
      body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await runNow(s, body as Record<string, unknown>), 201);
  } catch (e) {
    return fail(e);
  }
}

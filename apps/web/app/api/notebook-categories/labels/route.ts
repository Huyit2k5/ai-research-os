import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { setNotebookCategory } from "../../../../lib/notebook-categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body { account_id, ref, category_id }; category_id null removes the label. */
export async function PUT(req: Request) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || !("category_id" in body)) {
      throw new AppError(400, "Dữ liệu không hợp lệ.");
    }
    return json(await setNotebookCategory(s, body.account_id, body.ref, body.category_id));
  } catch (e) {
    return fail(e);
  }
}

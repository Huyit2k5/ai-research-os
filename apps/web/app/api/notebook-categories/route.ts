import { AppError } from "../../../lib/server";
import { fail, json, owner } from "../../../lib/papers";
import { createNotebookCategory, listNotebookCategories } from "../../../lib/notebook-categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return json(await listNotebookCategories(await owner(req, { allowToken: true })));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    if (!body || typeof body !== "object") throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await createNotebookCategory(s, body.name), 201);
  } catch (e) {
    return fail(e);
  }
}

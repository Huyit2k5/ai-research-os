import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { deleteNotebookCategory, renameNotebookCategory } from "../../../../lib/notebook-categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    if (!body || typeof body !== "object") throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await renameNotebookCategory(s, (await params).id, body.name));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    await deleteNotebookCategory(await owner(req, { allowToken: true }), (await params).id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return fail(e);
  }
}

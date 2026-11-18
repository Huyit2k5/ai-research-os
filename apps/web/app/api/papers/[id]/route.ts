import { AppError } from "../../../../lib/server";
import { deletePaper, fail, getPaper, json, listNotes, owner, updatePaper } from "../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = (id: string) => { if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(404, "Không tìm thấy paper."); return Number(id); };

export async function GET(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id);
    // Paper with added_by/can_delete; notes from every member with author/mine/can_delete.
    const paper = await getPaper(s, id);
    return json({ ...paper, notes: await listNotes(s, id) });
  } catch (e) { return fail(e); }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await updatePaper(s, id, body as Record<string, unknown>));
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req);
    await deletePaper(s, idOf((await params).id));
    return new Response(null, { status: 204 });
  } catch (e) { return fail(e); }
}

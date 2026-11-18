import { AppError } from "../../../../../lib/server";
import { addNote, deleteNote, fail, json, owner, updateNote } from "../../../../../lib/papers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = (id: string) => { if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(404, "Không tìm thấy paper."); return Number(id); };
const noteIdOf = (req: Request) => { const v = new URL(req.url).searchParams.get("note_id") || ""; if (!/^[1-9][0-9]{0,9}$/.test(v)) throw new AppError(422, "Ghi chú không hợp lệ."); return Number(v); };

export async function POST(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id);
    const body = await req.json().catch(() => null);
    return json(await addNote(s, id, body?.body), 201);
  } catch (e) { return fail(e); }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id), noteId = noteIdOf(req);
    const body = await req.json().catch(() => null);
    return json(await updateNote(s, id, noteId, body?.body));
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id), noteId = noteIdOf(req);
    await deleteNote(s, id, noteId);
    return new Response(null, { status: 204 });
  } catch (e) { return fail(e); }
}

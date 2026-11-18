import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { deleteDoc, getDoc, updateDoc } from "../../../../lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  try { return json(await getDoc(await owner(req, { allowToken: true }), (await params).id)); } catch (e) { return fail(e); }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req, { allowToken: true });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await updateDoc(s, (await params).id, body as Record<string, unknown>));
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try { await deleteDoc(await owner(req, { allowToken: true }), (await params).id); return new Response(null, { status: 204 }); } catch (e) { return fail(e); }
}

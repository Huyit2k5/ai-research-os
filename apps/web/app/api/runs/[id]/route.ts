import { AppError } from "../../../../lib/server";
import { fail, json, owner } from "../../../../lib/papers";
import { deleteRun, getRun, updateRun } from "../../../../lib/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = (id: string) => { if (!/^[1-9][0-9]{0,9}$/.test(id)) throw new AppError(404, "Không tìm thấy run."); return Number(id); };

export async function GET(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id), code = new URL(req.url).searchParams.get("code");
    return json(await getRun(s, id, { withCode: code === "1" || code === "true" }));
  } catch (e) { return fail(e); }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req), id = idOf((await params).id);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Dữ liệu không hợp lệ.");
    return json(await updateRun(s, id, body as Record<string, unknown>));
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const s = await owner(req);
    await deleteRun(s, idOf((await params).id));
    return new Response(null, { status: 204 });
  } catch (e) { return fail(e); }
}

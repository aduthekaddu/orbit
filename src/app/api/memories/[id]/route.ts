import { deleteMemory, memoryJson, MemoryRejected, updateMemory } from "@/lib/memory/store";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({
  id: r.text(LIMITS.id).min(1),
});

const bodySchema = r.object({
  text: r.text(LIMITS.memoryText),
  kind: r.enum(["fact", "preference", "summary"]),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Invalid memory" }, { status: 400 });
  try {
    const memory = updateMemory(params.data.id, { ...parsed.data, source: "user" });
    if (!memory) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ memory: memoryJson(memory) });
  } catch (error) {
    if (error instanceof MemoryRejected) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  if (!deleteMemory(params.data.id)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: params.data.id });
}

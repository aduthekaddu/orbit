import { cleanMemoryText, deleteMemory, getMemory, memoryJson, MemoryRejected, updateMemory } from "@/lib/memory/store";
import { requestRedactor } from "@/lib/request-redactor";
import { sessionFrom, unauthorized } from "@/lib/session";
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
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success || !getMemory(session.user.id, params.data.id)) return Response.json({ error: "Not found" }, { status: 404 });
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Invalid memory" }, { status: 400 });
  try {
    const redact = requestRedactor(session.user);
    const text = redact.text(cleanMemoryText(redact.text(parsed.data.text)));
    const memory = updateMemory(session.user.id, params.data.id, { ...parsed.data, text, source: "user" });
    if (!memory) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ memory: memoryJson(memory) });
  } catch (error) {
    if (error instanceof MemoryRejected) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  if (!deleteMemory(session.user.id, params.data.id)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: params.data.id });
}

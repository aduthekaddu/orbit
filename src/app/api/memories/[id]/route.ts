import { z } from "zod";
import { deleteMemory, memoryJson, MemoryRejected, updateMemory } from "@/lib/memory/store";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  id: z.string().min(1).max(100),
});

const bodySchema = z.object({
  text: z.string().max(2000),
  kind: z.enum(["fact", "preference", "summary"]),
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
    const memory = updateMemory(params.data.id, parsed.data);
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

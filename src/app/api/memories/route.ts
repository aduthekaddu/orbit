import { z } from "zod";
import { memoryEmbeddings } from "@/lib/memory/embed";
import { listMemories, memoryJson } from "@/lib/memory/store";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().max(500),
});

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = querySchema.safeParse({
    q: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (!parsed.success) return Response.json({ error: "Invalid search" }, { status: 400 });
  const embeddings = await memoryEmbeddings();
  return Response.json({
    embeddings,
    memories: listMemories(parsed.data.q).map(memoryJson),
  });
}

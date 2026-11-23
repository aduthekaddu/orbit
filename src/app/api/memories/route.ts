import { memoryEmbeddings } from "@/lib/memory/embed";
import { listMemories, memoryJson } from "@/lib/memory/store";
import { getSession, unauthorized } from "@/lib/session";
import { LIMITS, r } from "@/lib/route-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = r.object({
  q: r.text(LIMITS.query),
});

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();
  const parsed = querySchema.safeParse({
    q: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (!parsed.success) return Response.json({ error: "Invalid search" }, { status: 400 });
  const memories = listMemories(parsed.data.q).map(memoryJson);
  const embeddings = await memoryEmbeddings();
  return Response.json({ embeddings, memories });
}

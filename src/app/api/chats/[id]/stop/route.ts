import { getChatForUser } from "@/lib/messages";
import { stopReplyRun } from "@/lib/reply-runs";
import { LIMITS, r } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = params.data;
  if (!getChatForUser(id, session.user.id)) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ok: true, stopped: stopReplyRun(id, session.user.id) });
}

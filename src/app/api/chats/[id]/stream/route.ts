import { getChatForUser } from "@/lib/messages";
import { findReplyRun, replyResponse } from "@/lib/reply-runs";
import { LIMITS, r } from "@/lib/route-schema";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
const querySchema = r.object({ replyId: r.text(LIMITS.id).min(1).optional() });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = params.data;
  if (!getChatForUser(id, session.user.id)) return Response.json({ error: "Not found" }, { status: 404 });

  const query = querySchema.safeParse({ replyId: new URL(request.url).searchParams.get("replyId") ?? undefined });
  if (!query.success) return Response.json({ error: "Invalid reply id" }, { status: 400 });
  const match = findReplyRun(id, session.user.id, query.data.replyId);
  return match ? replyResponse(match.run, match.replyId) : new Response(null, { status: 204 });
}

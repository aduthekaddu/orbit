import { getChatForUser, messageRepository } from "@/lib/messages";
import { LIMITS, r } from "@/lib/route-schema";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const chat = getChatForUser(params.data.id, session.user.id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    id: chat.id,
    title: chat.title,
    ...messageRepository(chat.id),
  });
}

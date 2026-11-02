import { getChatForUser, messageRepository } from "@/lib/messages";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const { id } = await context.params;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    id: chat.id,
    title: chat.title,
    ...messageRepository(chat.id),
  });
}

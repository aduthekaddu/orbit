import { z } from "zod";
import { getChatForUser, touchChat, updateMessageText } from "@/lib/messages";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  text: z.string().max(200_000),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string; messageId: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const { id, messageId } = await context.params;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message text" }, { status: 400 });
  if (!updateMessageText(chat.id, messageId, parsed.data.text)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  touchChat(chat.id);
  return Response.json({ ok: true });
}

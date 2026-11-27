import { getChatForUser, touchChat, updateMessageText } from "@/lib/messages";
import { LIMITS, r } from "@/lib/route-schema";
import { getSession, unauthorized } from "@/lib/session";
import { requestRedactor } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = r.object({
  text: r.requiredText(LIMITS.assistantText),
  partIndex: r.number().int().nonnegative().optional(),
});

const paramsSchema = r.object({
  id: r.text(LIMITS.id).min(1),
  messageId: r.text(LIMITS.id).min(1),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string; messageId: string }> }) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
  const { id, messageId } = params.data;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message text" }, { status: 400 });
  const redact = requestRedactor(session.user.id);
  if (!updateMessageText(chat.id, messageId, parsed.data.text, redact, parsed.data.partIndex)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  touchChat(chat.id);
  return Response.json({ ok: true });
}

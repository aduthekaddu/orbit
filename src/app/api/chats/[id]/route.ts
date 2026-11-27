import { deleteChat, getChatForUser, messageRepository, renameChat } from "@/lib/messages";
import { deleteAfterReply } from "@/lib/reply-runs";
import { LIMITS, r, readJsonBody } from "@/lib/route-schema";
import { getSession, unauthorized } from "@/lib/session";
import { requestRedactor } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
const renameSchema = r.object({ title: r.requiredText(LIMITS.chatTitle) }).strict();
const RENAME_BYTES = 4096;

type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const chat = getChatForUser(params.data.id, session.user.id);
  if (!chat) return notFound();
  return Response.json({
    id: chat.id,
    title: chat.title,
    ...messageRepository(chat.id),
  });
}

export async function PATCH(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const body = await readJsonBody(request, RENAME_BYTES);
  if (!body.ok) {
    if (body.reason === "too-large") return Response.json({ error: "Request body is too large." }, { status: 413 });
    return Response.json({ error: "Invalid chat title" }, { status: 400 });
  }
  const parsed = renameSchema.safeParse(body.json);
  if (!parsed.success) return Response.json({ error: "Invalid chat title" }, { status: 400 });
  const renamed = renameChat(params.data.id, session.user.id, parsed.data.title, requestRedactor(session.user.id));
  if (!renamed) return notFound();
  return Response.json(renamed);
}

export async function DELETE(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const { id } = params.data;
  // Ownership first, so nobody can stop another user's reply.
  if (!getChatForUser(id, session.user.id)) return notFound();
  if (!(await deleteAfterReply(id, () => deleteChat(id, session.user.id)))) return notFound();
  return new Response(null, { status: 204 });
}

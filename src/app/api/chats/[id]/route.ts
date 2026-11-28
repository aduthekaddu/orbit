import { deleteChat, getChatForUser, messageRepository, parseDisabledTools, renameChat, switchChatTools } from "@/lib/messages";
import { deleteAfterReply } from "@/lib/reply-runs";
import { disabledToolsSchema, LIMITS, r, readJsonBody } from "@/lib/route-schema";
import { sessionFrom, unauthorized } from "@/lib/session";
import { requestRedactor } from "@/lib/request-redactor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = r.object({ id: r.text(LIMITS.id).min(1) });
// A tools change names only the switches that moved, so a tab with an older list cannot undo another tab's change.
const patchSchema = r.object({
  title: r.requiredText(LIMITS.chatTitle).optional(),
  toolsOff: disabledToolsSchema.optional(),
  toolsOn: disabledToolsSchema.optional(),
}).strict()
  .refine((value) => value.title !== undefined || value.toolsOff !== undefined || value.toolsOn !== undefined)
  .refine(({ toolsOff = [], toolsOn = [] }) => !toolsOff.some((id) => toolsOn.includes(id)));
const PATCH_BYTES = 4096;
const invalid = () => Response.json({ error: "Invalid chat update" }, { status: 400 });

type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const chat = getChatForUser(params.data.id, session.user.id);
  if (!chat) return notFound();
  return Response.json({
    id: chat.id,
    title: chat.title,
    disabledTools: parseDisabledTools(chat.disabledTools),
    ...messageRepository(chat.id),
  });
}

export async function PATCH(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const body = await readJsonBody(request, PATCH_BYTES);
  if (!body.ok) {
    if (body.reason === "too-large") return Response.json({ error: "Request body is too large." }, { status: 413 });
    return invalid();
  }
  const parsed = patchSchema.safeParse(body.json);
  if (!parsed.success) return invalid();
  const { id } = params.data;
  const { title, toolsOff = [], toolsOn = [] } = parsed.data;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) return notFound();
  // No await from here on, so both writes land on the chat the check above found. Tools go first, since they can refuse.
  const tools = switchChatTools(id, session.user.id, { off: toolsOff, on: toolsOn });
  if (tools.status === "too-many") return invalid();
  if (tools.status === "not-found") return notFound();
  const renamed = title === undefined ? chat : renameChat(id, session.user.id, title, requestRedactor(session.user));
  if (!renamed) return notFound();
  return Response.json({ id, title: renamed.title, disabledTools: tools.disabledTools });
}

export async function DELETE(request: Request, context: Context) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return notFound();
  const { id } = params.data;
  // Ownership first, so nobody can stop another user's reply.
  if (!getChatForUser(id, session.user.id)) return notFound();
  if (!(await deleteAfterReply(id, () => deleteChat(id, session.user.id)))) return notFound();
  return new Response(null, { status: 204 });
}

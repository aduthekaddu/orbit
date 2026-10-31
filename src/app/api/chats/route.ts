import { createChat, listChats } from "@/lib/messages";
import { getSession, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();
  return Response.json({ chats: listChats(session.user.id) });
}

export async function POST() {
  const session = await getSession();
  if (!session) return unauthorized();
  return Response.json(createChat(session.user.id), { status: 201 });
}

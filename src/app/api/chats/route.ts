import { createChat, listChats } from "@/lib/messages";
import { sessionFrom, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json({ chats: listChats(session.user.id) });
}

export async function POST(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return unauthorized();
  return Response.json(createChat(session.user.id), { status: 201 });
}

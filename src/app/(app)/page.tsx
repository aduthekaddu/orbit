import { redirect } from "next/navigation";
import { createChat, listChats } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await requireUser();
  const chats = listChats(session.user.id);
  if (chats[0]) redirect(`/c/${chats[0].id}`);
  const created = createChat(session.user.id);
  redirect(`/c/${created.id}`);
}

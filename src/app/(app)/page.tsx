import { redirect } from "next/navigation";
import { listChats } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await requireUser();
  const chats = listChats(session.user.id);
  // Straight to a draft instead of through /new, so a first visit takes one redirect.
  redirect(chats[0] ? `/c/${chats[0].id}` : `/c/${crypto.randomUUID()}?new`);
}

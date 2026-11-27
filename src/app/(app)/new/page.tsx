import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// A draft has no chats row until its first message commits. The server mints the id because browser
// crypto.randomUUID needs a secure context, and Orbit may be served over plain HTTP.
export default async function NewChatPage() {
  await requireUser();
  redirect(`/c/${crypto.randomUUID()}?new`);
}

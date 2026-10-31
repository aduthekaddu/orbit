import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { getChatForUser, listMessages } from "@/lib/messages";
import { getSettings } from "@/lib/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireUser();
  const { id } = await params;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) notFound();
  const messages = listMessages(id);
  const settings = getSettings();
  const ready = Boolean(settings?.baseUrl && settings.apiKey && settings.model);
  return (
    <div className="min-h-0 flex-1">
      <ChatPanel key={id} chatId={id} initialMessages={messages} ready={ready} model={settings?.model ?? ""} />
    </div>
  );
}

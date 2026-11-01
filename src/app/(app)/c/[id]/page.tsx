import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { Figure } from "@/components/figure";
import { SettingsForm } from "@/components/settings/settings-form";
import { getChatForUser, listMessages } from "@/lib/messages";
import { getSettings, toPublicSettings } from "@/lib/settings";
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
  if (!ready && messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[8vh] scrollbar-thin">
        <div className="w-40 animate-rise">
          <Figure name="plug" />
        </div>
        <SettingsForm initial={toPublicSettings(settings)} title="Connect a provider" />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <ChatPanel key={id} chatId={id} initialMessages={messages} ready={ready} model={settings?.model ?? ""} />
    </div>
  );
}

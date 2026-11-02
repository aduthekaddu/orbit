import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { Figure } from "@/components/figure";
import { SettingsForm } from "@/components/settings/settings-form";
import { getChatForUser, messageRepository } from "@/lib/messages";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { artifactHistory } from "@/lib/artifacts/history";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifact?: string | string[] }>;
}) {
  const session = await requireUser();
  const { id } = await params;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) notFound();
  const query = await searchParams;
  const repository = artifactHistory(messageRepository(id), typeof query.artifact === "string" ? query.artifact : undefined);
  const settings = getSettings();
  const ready = Boolean(settings?.baseUrl && settings.apiKey && settings.model);
  if (!ready && repository.messages.length === 0) {
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
      <ChatPanel key={id} chatId={id} initialHistory={repository} ready={ready} model={settings?.model ?? ""} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { Figure } from "@/components/figure";
import { FirstRun } from "@/components/settings/first-run";
import { getModelDefaults } from "@/lib/connections";
import { effortLevels } from "@/lib/effort";
import { cachedCaps } from "@/lib/model-list";
import { getChatForUser, messageRepository } from "@/lib/messages";
import { resolveChoice } from "@/lib/model-choice";
import { artifactHistory } from "@/lib/artifacts/history";
import { requireUser } from "@/lib/session";
import { publicConnections } from "@/lib/settings";
import { focusedHead } from "@/lib/chat-tree";
import { findActiveReplyRun } from "@/lib/reply-runs";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ m?: string | string[]; artifact?: string | string[] }>;
}) {
  const session = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const focusMessageId = typeof query.m === "string" ? query.m : null;
  const chat = getChatForUser(id, session.user.id);
  if (!chat) notFound();
  const saved = messageRepository(id);
  const repository = artifactHistory(saved, typeof query.artifact === "string" ? query.artifact : undefined);
  const selectedHead = focusedHead(
    repository.messages.map(({ message, parentId }) => ({ id: message.id, parentId })),
    repository.headId,
    focusMessageId,
  );
  const active = findActiveReplyRun(id, session.user.id);
  const liveReplyId = active && selectedHead === active.promptId ? active.replyId : null;
  const restorePending = active ? liveReplyId !== null : selectedHead === saved.headId;
  const resolved = resolveChoice(session.user.id, chat);
  if (!resolved.ok && repository.messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[8vh] scrollbar-thin">
        <div className="w-40 animate-rise">
          <Figure name="plug" />
        </div>
        <div className="mx-auto w-full max-w-page px-6 py-10">
          <h1 className="mb-6 text-xl font-semibold tracking-tight">Connect a provider</h1>
          <FirstRun reason={resolved.reason} initialConnections={publicConnections(session.user.id)} defaults={getModelDefaults(session.user.id)} />
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <ChatPanel key={`${id}:${focusMessageId ?? ""}`} chatId={id} focusMessageId={focusMessageId} initialHistory={repository} choice={resolved.ok || resolved.reason === "key-unreadable" ? resolved.choice : null} choiceLevels={resolved.ok ? effortLevels(resolved.connection.kind, cachedCaps(resolved.connection.id, resolved.choice.model)) : null} connections={publicConnections(session.user.id)} liveReplyId={liveReplyId} restorePending={restorePending} />
    </div>
  );
}

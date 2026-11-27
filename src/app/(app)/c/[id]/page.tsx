import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { Figure } from "@/components/figure";
import { FirstRun } from "@/components/settings/first-run";
import { getModelDefaults } from "@/lib/connections";
import { effortLevels } from "@/lib/effort";
import { getInstance } from "@/lib/instance-settings";
import { cachedCaps } from "@/lib/model-list";
import { chatExists, getChatForUser, messageRepository } from "@/lib/messages";
import { NOTHING_PINNED, resolveChoice } from "@/lib/model-choice";
import { policyFor } from "@/lib/policy";
import { artifactHistory } from "@/lib/artifacts/history";
import { LIMITS } from "@/lib/route-schema";
import { requireUser } from "@/lib/session";
import { publicConnections } from "@/lib/request-redactor";
import { focusedHead, toRepository } from "@/lib/chat-tree";
import { findActiveReplyRun } from "@/lib/reply-runs";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ m?: string | string[]; artifact?: string | string[]; new?: string | string[] }>;
}) {
  const session = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const focusMessageId = typeof query.m === "string" ? query.m : null;
  const chat = getChatForUser(id, session.user.id);
  // `?new` opens a draft only for an id no one has used. Another user's chat, or a deleted one without `?new`, is a 404.
  const isDraft = chat === null;
  if (isDraft && (query.new === undefined || id.length > LIMITS.id || chatExists(id))) notFound();
  const saved = isDraft ? toRepository([], null) : messageRepository(id);
  const repository = artifactHistory(saved, typeof query.artifact === "string" ? query.artifact : undefined);
  const selectedHead = focusedHead(
    repository.messages.map(({ message, parentId }) => ({ id: message.id, parentId })),
    repository.headId,
    focusMessageId,
  );
  const active = isDraft ? null : findActiveReplyRun(id, session.user.id);
  const liveReplyId = active && selectedHead === active.promptId ? active.replyId : null;
  const restorePending = isDraft ? false : active ? liveReplyId !== null : selectedHead === saved.headId;
  const resolved = resolveChoice(session.user, chat ?? NOTHING_PINNED);
  const canManageConnections = policyFor(getInstance().hostingMode).mayCreateConnection(session.user);
  const connections = publicConnections(session.user);
  if (!resolved.ok && repository.messages.length === 0) {
    let title = "Connect a provider";
    if (!canManageConnections) {
      title = resolved.reason === "no-model" && connections.length > 0 ? "Choose a model" : "Provider unavailable";
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[8vh] scrollbar-thin">
        <div className="w-40 animate-rise">
          <Figure name="plug" />
        </div>
        <div className="mx-auto w-full max-w-page px-6 py-10">
          <h1 className="mb-6 text-xl font-semibold tracking-tight">{title}</h1>
          <FirstRun reason={resolved.reason} initialConnections={connections} defaults={getModelDefaults(session.user.id)} canManageConnections={canManageConnections} />
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <ChatPanel
        key={`${id}:${focusMessageId ?? ""}`}
        chatId={id}
        isDraft={isDraft}
        focusMessageId={focusMessageId}
        initialHistory={repository}
        choice={resolved.ok || (canManageConnections && resolved.reason === "key-unreadable") ? resolved.choice : null}
        choiceLevels={resolved.ok ? effortLevels(resolved.connection.kind, cachedCaps(resolved.connection.id, resolved.choice.model)) : null}
        connections={connections}
        canManageConnections={canManageConnections}
        liveReplyId={liveReplyId}
        restorePending={restorePending}
      />
    </div>
  );
}

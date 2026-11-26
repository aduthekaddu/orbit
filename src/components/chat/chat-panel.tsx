"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider, type ThreadHistoryAdapter } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { focusedHead, type toRepository } from "@/lib/chat-tree";
import { hasOpenCodeRun } from "@/lib/chat-stopped-runs";
import { orbitChatTransport } from "@/lib/chat-transport";
import type { PublicConnection } from "@/lib/connections";
import type { Effort } from "@/lib/effort";
import type { ModelChoice } from "@/lib/model-choice";
import { ArtifactProvider } from "@/components/artifacts/use-artifact";
import { ArtifactWorkspace } from "@/components/artifacts/artifact-panel";
import { ChatIdProvider } from "./chat-id";
import { ModelChoiceProvider } from "./model-picker";
import { createReplyLink, ReplyLink } from "./reply-link";
import { StoppedRunSync } from "./stopped-run-sync";
import { Thread } from "./thread";

export function ChatPanel({
  chatId,
  initialHistory,
  focusMessageId,
  choice: initialChoice,
  choiceLevels = null,
  connections,
  liveReplyId = null,
  restorePending = true,
}: {
  chatId: string;
  initialHistory: ReturnType<typeof toRepository>;
  focusMessageId: string | null;
  choice: ModelChoice | null;
  choiceLevels?: Effort[] | null;
  connections: PublicConnection[];
  liveReplyId?: string | null;
  restorePending?: boolean;
}) {
  const router = useRouter();
  const editMessageId = useRef<string | null>(null);
  const [choice, setChoice] = useState(initialChoice);
  const sendChoice = useRef(initialChoice);
  const [stopped, setStopped] = useState<string[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const link = useMemo(() => createReplyLink(chatId, () => router.refresh()), [chatId, router]);
  const { state } = useSyncExternalStore(link.subscribe, link.getSnapshot, link.getServerSnapshot);
  const rows = useMemo(() => initialHistory.messages.map(({ parentId, message }) => ({ id: message.id, parentId })), [initialHistory]);
  const savedIds = useMemo(() => new Set(rows.map((message) => message.id)), [rows]);
  const headId = focusedHead(rows, initialHistory.headId, focusMessageId);
  const transport = useMemo(() => orbitChatTransport(chatId, {
    editMessageId: () => {
      const id = editMessageId.current;
      editMessageId.current = null;
      return id;
    },
    modelChoice: () => sendChoice.current,
    onReplyId: link.accept,
    onReconnectResponse: link.reconnectResponse,
    onServerTime: link.syncClock,
  }), [chatId, link]);
  const history = useMemo<ThreadHistoryAdapter>(() => ({
    async load() { throw new Error("Chat history requires the ai-sdk/v6 format"); },
    async append() {},
    withFormat(format) {
      if (format.format !== "ai-sdk/v6") throw new Error("Unsupported chat history format");
      return {
        async load() {
          const messages = initialHistory.messages.map(({ parentId, message: { id, ...content } }) => format.decode({
            id, parent_id: parentId, format: format.format,
            content: content as unknown as Parameters<typeof format.decode>[0]["content"],
          }));
          setHistoryLoaded(true);
          return { headId, messages };
        },
        // POST /api/chat already stores each message, so the history adapter must not write it again.
        async append() {},
      };
    },
  }), [headId, initialHistory]);
  const runtime = useChatRuntime({
    id: chatId,
    adapters: { history },
    transport,
    isSendDisabled: state.kind === "reconnecting" || state.kind === "stopping",
    onFinish: ({ message, messages, isAbort, isDisconnect }) => {
      link.finish({ isAbort, isDisconnect, messages });
      if (!isDisconnect && hasOpenCodeRun(message)) {
        setStopped((ids) => ids.includes(message.id) ? ids : [...ids, message.id]);
      }
    },
  });

  useEffect(() => {
    void runtime.threads.mainItem.initialize();
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatIdProvider chatId={chatId} onEdit={(id) => { editMessageId.current = id; }}>
        <ReplyLink link={link} historyLoaded={historyLoaded} headId={headId} liveReplyId={liveReplyId} savedIds={savedIds} restorePending={restorePending}>
          <ArtifactProvider>
            <StoppedRunSync chatId={chatId} stopped={stopped}>
              <ArtifactWorkspace>
                <ModelChoiceProvider
                  choice={choice}
                  connections={connections}
                  levels={choiceLevels}
                  onChoose={(next) => {
                    sendChoice.current = next;
                    setChoice(next);
                  }}
                >
                  <Thread ready={choice !== null} focusMessageId={focusMessageId} hasHistory={initialHistory.messages.length > 0} />
                </ModelChoiceProvider>
              </ArtifactWorkspace>
            </StoppedRunSync>
          </ArtifactProvider>
        </ReplyLink>
      </ChatIdProvider>
    </AssistantRuntimeProvider>
  );
}

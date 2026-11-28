"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider, type ThreadHistoryAdapter } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { focusedHead, type toRepository } from "@/lib/chat-tree";
import { hasOpenCodeRun } from "@/lib/chat-stopped-runs";
import { orbitChatTransport } from "@/lib/chat-transport";
import type { PickableConnection } from "@/lib/connections";
import type { Effort } from "@/lib/effort";
import type { ModelChoice } from "@/lib/model-choice";
import { ArtifactProvider } from "@/components/artifacts/use-artifact";
import { ArtifactWorkspace } from "@/components/artifacts/artifact-panel";
import { ChatIdProvider } from "./chat-id";
import { dropNewParam } from "./draft-url";
import { ModelChoiceProvider } from "./model-picker";
import { createReplyLink, ReplyLink } from "./reply-link";
import { StoppedRunSync } from "./stopped-run-sync";
import { Thread } from "./thread";
import { createToolsStore, ToolsProvider, type AvailableTool } from "./tools-sheet";

const NO_TOOLS: AvailableTool[] = [];
const NONE_OFF: string[] = [];

export function ChatPanel({
  chatId,
  isDraft = false,
  initialHistory,
  focusMessageId,
  choice: resolvedChoice,
  choiceLevels = null,
  connections,
  canManageConnections,
  needsOwnConnection = false,
  liveReplyId = null,
  restorePending = true,
  availableTools = NO_TOOLS,
  initialDisabledTools = NONE_OFF,
}: {
  chatId: string;
  /** `/c/<id>?new` with no chats row yet. The first send creates the row. */
  isDraft?: boolean;
  initialHistory: ReturnType<typeof toRepository>;
  focusMessageId: string | null;
  choice: ModelChoice | null;
  choiceLevels?: Effort[] | null;
  connections: PickableConnection[];
  canManageConnections: boolean;
  needsOwnConnection?: boolean;
  liveReplyId?: string | null;
  restorePending?: boolean;
  /** The ready tools this chat may turn off. */
  availableTools?: AvailableTool[];
  initialDisabledTools?: string[];
}) {
  const router = useRouter();
  const editMessageId = useRef<string | null>(null);
  // A pick in the picker holds until its connection is gone. Without one the chat uses the choice the page resolved,
  // its pinned choice or the defaults, which a refresh can change.
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const choice = picked && connections.some((connection) => connection.id === picked.connectionId) ? picked : resolvedChoice;
  const sendChoice = useRef(choice);
  useEffect(() => {
    sendChoice.current = choice;
  }, [choice]);
  const [stopped, setStopped] = useState<string[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Offline, a refresh cannot fetch the page, so Next loads it in full instead, and the browser shows its offline
  // page and then reloads, which drops a draft's picked model. The refresh waits for the connection.
  const refreshOnline = useRef<AbortController | null>(null);
  useEffect(() => () => refreshOnline.current?.abort(), []);
  const link = useMemo(() => createReplyLink(chatId, () => {
    if (navigator.onLine) {
      router.refresh();
      return;
    }
    if (refreshOnline.current && !refreshOnline.current.signal.aborted) return;
    const waiting = new AbortController();
    refreshOnline.current = waiting;
    window.addEventListener("online", () => {
      waiting.abort();
      router.refresh();
    }, { once: true, signal: waiting.signal });
  }), [chatId, router]);
  // A draft that sent its first message may have a saved chat row before any answer arrives.
  const sentDraft = useRef(false);
  const draft = useRef(isDraft);
  useEffect(() => {
    draft.current = isDraft;
    // A send that dropped before its headers lands here once a refresh finds the committed row.
    if (!isDraft) dropNewParam(chatId);
  }, [chatId, isDraft]);
  const [tools] = useState(() => createToolsStore({ chatId, initialDisabledTools, draft: isDraft }));
  // A first send that lost its reply id still saved the row, which the refresh after it finds.
  useEffect(() => {
    if (!isDraft) tools.chatCreated(initialDisabledTools);
  }, [initialDisabledTools, isDraft, tools]);
  useEffect(() => () => {
    // Leaving before the reply ends skips its refresh, and the sidebar would miss the new chat. The server can save
    // the chat seconds before the headers arrive, so any send counts. A refresh after a failed send changes nothing.
    if (draft.current && sentDraft.current) router.refresh();
  }, [router]);
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
    disabledTools: () => tools.draftDisabledTools(),
    beforeSend: () => tools.flush(),
    onSend: () => {
      if (draft.current) sentDraft.current = true;
      tools.sendStarted();
    },
    // A reply ID proves POST /api/chat committed the chat and its prompt, so a reload must open the saved chat.
    onReplyId: (replyId) => {
      if (draft.current) dropNewParam(chatId);
      tools.chatCreated();
      link.accept(replyId);
    },
    onReconnectResponse: link.reconnectResponse,
    onServerTime: link.syncClock,
  }), [chatId, link, tools]);
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
    // The SDK calls onFinish after an error or an abort too, so a refused first send unlocks the switches.
    onFinish: ({ message, messages, isAbort, isDisconnect }) => {
      tools.sendFinished();
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
                  canManageConnections={canManageConnections}
                  known={resolvedChoice && { connectionId: resolvedChoice.connectionId, model: resolvedChoice.model, levels: choiceLevels }}
                  onChoose={setPicked}
                >
                  <ToolsProvider store={tools} availableTools={availableTools}>
                    <Thread ready={choice !== null} needsOwnConnection={needsOwnConnection} focusMessageId={focusMessageId} hasHistory={initialHistory.messages.length > 0} />
                  </ToolsProvider>
                </ModelChoiceProvider>
              </ArtifactWorkspace>
            </StoppedRunSync>
          </ArtifactProvider>
        </ReplyLink>
      </ChatIdProvider>
    </AssistantRuntimeProvider>
  );
}

"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider, type ThreadHistoryAdapter } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { toRepository } from "@/lib/chat-tree";
import { orbitChatTransport } from "@/lib/chat-transport";
import { ChatIdProvider } from "./chat-id";
import { Thread } from "./thread";

export function ChatPanel({
  chatId,
  initialHistory,
  ready,
  model,
}: {
  chatId: string;
  initialHistory: ReturnType<typeof toRepository>;
  ready: boolean;
  model: string;
}) {
  const router = useRouter();
  const editMessageId = useRef<string | null>(null);
  const history = useMemo<ThreadHistoryAdapter>(() => ({
    async load() { throw new Error("Chat history requires the ai-sdk/v6 format"); },
    async append() {},
    withFormat(format) {
      if (format.format !== "ai-sdk/v6") throw new Error("Unsupported chat history format");
      return {
        async load() {
          return {
            headId: initialHistory.headId,
            messages: initialHistory.messages.map(({ parentId, message: { id, ...content } }) => format.decode({
              id, parent_id: parentId, format: format.format,
              content: content as unknown as Parameters<typeof format.decode>[0]["content"],
            })),
          };
        },
        // POST /api/chat already stores each message, so the history adapter must not write it again.
        async append() {},
      };
    },
  }), [initialHistory]);
  const runtime = useChatRuntime({
    id: chatId,
    adapters: { history },
    transport: orbitChatTransport(chatId, { editMessageId: () => { const id = editMessageId.current; editMessageId.current = null; return id; } }),
    onFinish: () => {
      router.refresh();
    },
  });

  useEffect(() => {
    void runtime.threads.mainItem.initialize();
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatIdProvider chatId={chatId} onEdit={(id) => { editMessageId.current = id; }}>
        <Thread ready={ready} model={model} />
      </ChatIdProvider>
    </AssistantRuntimeProvider>
  );
}

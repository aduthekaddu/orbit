"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { orbitChatTransport } from "@/lib/chat-transport";
import { ChatIdProvider } from "./chat-id";
import { Thread } from "./thread";

export function ChatPanel({
  chatId,
  initialMessages,
  ready,
  model,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  ready: boolean;
  model: string;
}) {
  const router = useRouter();
  const editMessageId = useRef<string | null>(null);
  const runtime = useChatRuntime({
    id: chatId,
    messages: initialMessages,
    transport: orbitChatTransport(chatId, { editMessageId: () => { const id = editMessageId.current; editMessageId.current = null; return id; } }),
    onFinish: () => {
      router.refresh();
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatIdProvider chatId={chatId} onEdit={(id) => { editMessageId.current = id; }}>
        <Thread ready={ready} model={model} />
      </ChatIdProvider>
    </AssistantRuntimeProvider>
  );
}

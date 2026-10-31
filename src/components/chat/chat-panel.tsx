"use client";

import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
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
  const runtime = useChatRuntime({
    id: chatId,
    messages: initialMessages,
    transport: new AssistantChatTransport({
      api: "/api/chat",
      // assistant-ui swaps the request id for its own local thread id, which would file the reply under a new chat.
      prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
        body: { ...body, id: chatId, messages, trigger, messageId },
      }),
    }),
    onFinish: () => {
      router.refresh();
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread ready={ready} model={model} />
    </AssistantRuntimeProvider>
  );
}

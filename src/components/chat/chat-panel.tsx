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
    transport: new AssistantChatTransport({ api: "/api/chat" }),
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

"use client";

import { useRouter } from "next/navigation";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { orbitChatTransport } from "@/lib/chat-transport";
import { Thread } from "./thread";

export function ChatPanel({ chatId, initialMessages }: { chatId: string; initialMessages: UIMessage[] }) {
  const router = useRouter();
  const runtime = useChatRuntime({
    id: chatId,
    messages: initialMessages,
    transport: orbitChatTransport(chatId),
    onFinish: () => {
      router.refresh();
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

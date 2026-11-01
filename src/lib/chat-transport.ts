import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

export function orbitChatTransport(
  chatId: string,
  options?: { editMessageId?: () => string | null; api?: string; headers?: Record<string, string>; fetch?: typeof fetch },
) {
  return new AssistantChatTransport<UIMessage>({
    api: options?.api ?? "/api/chat",
    headers: options?.headers,
    fetch: options?.fetch,
    // assistant-ui replaces the request id with its local thread id. The open chat id has to win.
    prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
      body: { ...body, id: chatId, messages, trigger, messageId, editMessageId: trigger === "submit-message" ? options?.editMessageId?.() ?? undefined : undefined },
    }),
  });
}

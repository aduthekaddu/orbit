import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

export function orbitChatTransport(
  _chatId: string,
  options?: { api?: string; headers?: Record<string, string>; fetch?: typeof fetch },
) {
  return new AssistantChatTransport<UIMessage>({
    api: options?.api ?? "/api/chat",
    headers: options?.headers,
    fetch: options?.fetch,
  });
}

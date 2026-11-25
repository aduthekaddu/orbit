import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

// The AI SDK throws a refused response as an Error whose message is the whole body. Orbit routes
// refuse with `{ "error": "..." }`, so the composer would show that JSON. This passes the text on.
function plainRefusals(send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await send(input, init);
    if (response.ok) return response;
    const body: unknown = await response.clone().json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body ? body.error : null;
    if (typeof message !== "string") return response;
    return new Response(message, { status: response.status, statusText: response.statusText });
  };
}

export function orbitChatTransport(
  chatId: string,
  options?: { editMessageId?: () => string | null; api?: string; headers?: Record<string, string>; fetch?: typeof fetch },
) {
  return new AssistantChatTransport<UIMessage>({
    api: options?.api ?? "/api/chat",
    headers: options?.headers,
    fetch: plainRefusals((input, init) => (options?.fetch ?? fetch)(input, init)),
    // assistant-ui replaces the request id with its local thread id. The open chat id has to win.
    prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
      body: { ...body, id: chatId, messages, trigger, messageId, editMessageId: trigger === "submit-message" ? options?.editMessageId?.() ?? undefined : undefined },
    }),
  });
}

import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import type { ModelChoice } from "./model-choice";
import { SERVER_TIME_HEADER } from "./thought-time";

class OrbitChatTransport extends AssistantChatTransport<UIMessage> {
  protected processResponseStream(stream: ReadableStream<Uint8Array<ArrayBufferLike>>) {
    let terminalSeen = false;
    return super.processResponseStream(stream).pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error") terminalSeen = true;
        controller.enqueue(chunk);
      },
      flush() {
        if (!terminalSeen) throw new TypeError("Network connection ended before the reply finished.");
      },
    }));
  }
}

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
  options?: {
    editMessageId?: () => string | null;
    modelChoice?: () => ModelChoice | null;
    api?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
    onReplyId?: (replyId: string) => void;
    onReconnectResponse?: (status: number) => void;
    onServerTime?: (serverTime: number) => void;
  },
) {
  return new OrbitChatTransport({
    api: options?.api ?? "/api/chat",
    headers: options?.headers,
    fetch: plainRefusals(async (input, init) => {
      const response = await (options?.fetch ?? fetch)(input, init);
      if (!init?.signal?.aborted) {
        if (response.ok) {
          const rawTime = response.headers.get(SERVER_TIME_HEADER);
          if (rawTime && /^\d+$/.test(rawTime)) options?.onServerTime?.(Number(rawTime));
        }
        if (init?.method === "GET") options?.onReconnectResponse?.(response.status);
        else if (response.ok) {
          const replyId = response.headers.get("x-resumable-stream-id");
          if (replyId) options?.onReplyId?.(replyId);
        }
      }
      return response;
    }),
    prepareReconnectToStreamRequest: ({ body }) => {
      const replyId = typeof body?.replyId === "string" ? body.replyId : null;
      const query = replyId ? `?${new URLSearchParams({ replyId })}` : "";
      return { api: `/api/chats/${encodeURIComponent(chatId)}/stream${query}` };
    },
    // assistant-ui replaces the request id with its local thread id. The open chat id has to win.
    prepareSendMessagesRequest: ({ body, messages, trigger, messageId }) => ({
      body: {
        ...body,
        id: chatId,
        messages,
        trigger,
        messageId,
        editMessageId: trigger === "submit-message" ? options?.editMessageId?.() ?? undefined : undefined,
        modelChoice: options?.modelChoice?.() ?? undefined,
      },
    }),
  });
}

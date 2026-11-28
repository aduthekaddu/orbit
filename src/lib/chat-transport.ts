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

// Waits for `pending` unless `signal` aborts first, and then rejects with the abort reason the way fetch does.
function unlessAborted(pending: Promise<void> | undefined, signal: AbortSignal | null | undefined): Promise<void> {
  if (!pending || !signal) return pending ?? Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
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
    // A send can commit its rows on the server long before its headers come back.
    onSend?: () => void;
    onReconnectResponse?: (status: number) => void;
    onServerTime?: (serverTime: number) => void;
    // A draft's first send carries the tools it turned off. A saved chat returns undefined, since the server reads the row.
    disabledTools?: () => string[] | undefined;
    // Awaited before the request leaves, so a tools save still in flight applies to this reply. Stop ends the wait,
    // and the request never leaves. A saved chat's body carries no tools list, so the wait can follow its body.
    beforeSend?: () => Promise<void>;
  },
) {
  return new OrbitChatTransport({
    api: options?.api ?? "/api/chat",
    headers: options?.headers,
    fetch: plainRefusals(async (input, init) => {
      if (init?.method !== "GET") {
        await unlessAborted(options?.beforeSend?.(), init?.signal);
        options?.onSend?.();
      }
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
        disabledTools: options?.disabledTools?.(),
      },
    }),
  });
}

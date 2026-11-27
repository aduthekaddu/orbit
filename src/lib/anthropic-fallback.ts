import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";

// A turn a safety classifier declines is retried on another model inside the same Messages API call. The switch
// arrives as a custom part of this kind, and the SDK sends it back as a fallback block on later requests.
const FALLBACK = "anthropic.fallback";

const isFallback = (part: { type: string; kind?: string }) => part.type === "custom" && part.kind === FALLBACK;
const fallbackEndpoint = z.object({ model: z.string().min(1) });
const fallbackMetadata = z.object({ anthropic: z.object({ type: z.literal("fallback"), from: fallbackEndpoint, to: fallbackEndpoint }) });

/** The model a stream part hands the reply to, or null when the part is not a fallback. */
export function fallbackModel(part: { type: string; kind?: string; providerMetadata?: unknown }): string | null {
  if (!isFallback(part)) return null;
  const parsed = fallbackMetadata.safeParse(part.providerMetadata);
  return parsed.success ? parsed.data.anthropic.to.model : null;
}

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];

const REFUSED_PARTS = new Set(["reasoning", "reasoning-file", "tool-call"]);

/**
 * The API rejects a request that echoes thinking or tool use from before the last fallback block of an assistant
 * turn. This drops them, and the results of the dropped tool calls, wherever the history repeats such a turn.
 */
export function withoutRefusedParts(prompt: Prompt): Prompt {
  if (!prompt.some((message) => message.role === "assistant" && message.content.some(isFallback))) return prompt;
  let trimmed = [...prompt];
  while (true) {
    const dropped = new Set<string>();
    let laterFallback = false;
    // Anthropic joins consecutive assistant messages into one request message.
    for (let index = trimmed.length - 1; index >= 0; index--) {
      const message = trimmed[index];
      if (message.role !== "assistant") {
        laterFallback = false;
        continue;
      }
      const boundary = laterFallback ? message.content.length : message.content.findLastIndex(isFallback);
      if (boundary < 0) continue;
      laterFallback = true;
      const content = message.content.filter((part, position) => {
        if (position >= boundary || !REFUSED_PARTS.has(part.type)) return true;
        if (part.type === "tool-call") dropped.add(part.toolCallId);
        return false;
      });
      trimmed[index] = { ...message, content };
    }
    let removedToolMessage = false;
    trimmed = trimmed.flatMap((message): Prompt => {
      if (message.role !== "assistant" && message.role !== "tool") return [message];
      if (message.role === "assistant") {
        const content = message.content.filter((part) => part.type !== "tool-result" || !dropped.has(part.toolCallId));
        return content.length ? [{ ...message, content }] : [];
      }
      const content = message.content.filter((part) => part.type !== "tool-result" || !dropped.has(part.toolCallId));
      if (content.length) return [{ ...message, content }];
      removedToolMessage = true;
      return [];
    });
    // Removing an empty tool message can join two assistant messages. Check the new boundary as well.
    if (!removedToolMessage) break;
  }
  // A malformed marker still sets the cutoff, but cannot be sent back as a provider block.
  return trimmed.flatMap((message): Prompt => {
    if (message.role !== "assistant") return [message];
    const content = message.content.filter((part) => !isFallback(part) || fallbackMetadata.safeParse(part.providerOptions).success);
    return content.length ? [{ ...message, content }] : [];
  });
}

function acceptedToolParts(signal?: AbortSignal) {
  const pending: { id: string; part: LanguageModelV4StreamPart }[] = [];
  const refused = new Set<string>();
  let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
  let failed = false;
  return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(part, controller) {
      const hold = (id: string) => {
        if (!refused.has(id)) pending.push({ id, part });
      };
      switch (part.type) {
        case "tool-input-start":
        case "tool-input-delta":
        case "tool-input-end":
          hold(part.id);
          return;
        case "tool-approval-request":
        case "tool-call":
        case "tool-result":
          hold(part.toolCallId);
          return;
        case "finish":
          finish = part;
          return;
        case "error":
          failed = true;
          break;
        case "custom":
          if (isFallback(part)) {
            for (const { id } of pending) refused.add(id);
            pending.length = 0;
          }
          break;
      }
      controller.enqueue(part);
    },
    flush(controller) {
      if (!finish) return;
      const reason = finish.finishReason.unified;
      if (!failed && !signal?.aborted && (reason === "stop" || reason === "tool-calls")) {
        for (const { part } of pending) controller.enqueue(part);
      }
      controller.enqueue(finish);
    },
  });
}

export const anthropicFallbacks: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: { ...params.providerOptions, anthropic: { fallbacks: "default", ...params.providerOptions?.anthropic } },
    prompt: withoutRefusedParts(params.prompt),
  }),
  // Hold tool events until the provider finishes so a later fallback can discard the abandoned
  // segment before any of its calls reach the SDK's tool dispatcher.
  wrapStream: async ({ doStream, params }) => {
    const output = await doStream();
    return { ...output, stream: output.stream.pipeThrough(acceptedToolParts(params.abortSignal)) };
  },
};

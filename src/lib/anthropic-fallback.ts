import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";

// A turn a safety classifier declines is retried on another model inside the same Messages API call. The switch
// arrives as a custom part of this kind, and the SDK sends it back as a fallback block on later requests.
const FALLBACK = "anthropic.fallback";

const fallbackMetadata = z.object({ anthropic: z.object({ type: z.literal("fallback"), to: z.object({ model: z.string().min(1) }) }) });

/** The model a stream part hands the reply to, or null when the part is not a fallback. */
export function fallbackModel(part: { type: string; kind?: string; providerMetadata?: unknown }): string | null {
  if (part.type !== "custom" || part.kind !== FALLBACK) return null;
  return fallbackMetadata.parse(part.providerMetadata).anthropic.to.model;
}

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];

const REFUSED_PARTS = new Set(["reasoning", "reasoning-file", "tool-call"]);

/**
 * The API rejects a request that echoes thinking or tool use from before the last fallback block of an assistant
 * turn. This drops them, and the results of the dropped tool calls, wherever the history repeats such a turn.
 */
export function withoutRefusedParts(prompt: Prompt): Prompt {
  const dropped = new Set<string>();
  const trimmed = prompt.map((message) => {
    if (message.role !== "assistant") return message;
    const boundary = message.content.findLastIndex((part) => part.type === "custom" && part.kind === FALLBACK);
    if (boundary < 0) return message;
    const content = message.content.filter((part, index) => {
      if (index >= boundary || !REFUSED_PARTS.has(part.type)) return true;
      if (part.type === "tool-call") dropped.add(part.toolCallId);
      return false;
    });
    return { ...message, content };
  });
  if (dropped.size === 0) return trimmed;
  return trimmed.flatMap((message): Prompt => {
    if (message.role === "assistant") return [{ ...message, content: message.content.filter((part) => part.type !== "tool-result" || !dropped.has(part.toolCallId)) }];
    if (message.role !== "tool") return [message];
    const content = message.content.filter((part) => part.type !== "tool-result" || !dropped.has(part.toolCallId));
    return content.length > 0 ? [{ ...message, content }] : [];
  });
}

export const fallbackHistory: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, prompt: withoutRefusedParts(params.prompt) }),
};

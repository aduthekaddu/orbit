import type { ProviderMetadata, TextStreamPart, ToolSet, UIMessage } from "ai";
import { readOrbitTiming, type OrbitTiming } from "./thought-time";

type Span = { startedAt: number; metadata: ProviderMetadata };

function mergeMetadata(metadata: ProviderMetadata, incoming: ProviderMetadata | undefined) {
  for (const [provider, values] of Object.entries(incoming ?? {})) {
    metadata[provider] = { ...metadata[provider], ...values };
  }
}

export function stampReasoningTimes<Tools extends ToolSet>(now = Date.now) {
  const spans = new Map<string, Span>();
  const end = (id: string, span: Span): TextStreamPart<Tools> => ({
    type: "reasoning-end",
    id,
    providerMetadata: {
      ...span.metadata,
      orbitTiming: { startedAt: span.startedAt, thoughtMs: Math.max(0, now() - span.startedAt) },
    },
  });

  return new TransformStream<TextStreamPart<Tools>, TextStreamPart<Tools>>({
    transform(chunk, controller) {
      switch (chunk.type) {
        case "reasoning-start": {
          const span = { startedAt: now(), metadata: {} };
          mergeMetadata(span.metadata, chunk.providerMetadata);
          spans.set(chunk.id, span);
          controller.enqueue({ ...chunk, providerMetadata: { ...span.metadata, orbitTiming: { startedAt: span.startedAt } } });
          return;
        }
        case "reasoning-delta": {
          const span = spans.get(chunk.id);
          if (!span || !chunk.providerMetadata) break;
          mergeMetadata(span.metadata, chunk.providerMetadata);
          controller.enqueue({ ...chunk, providerMetadata: { ...span.metadata, orbitTiming: { startedAt: span.startedAt } } });
          return;
        }
        case "reasoning-end": {
          const span = spans.get(chunk.id);
          if (!span) break;
          mergeMetadata(span.metadata, chunk.providerMetadata);
          spans.delete(chunk.id);
          controller.enqueue(end(chunk.id, span));
          return;
        }
        case "abort":
          for (const [id, span] of spans) controller.enqueue(end(id, span));
          spans.clear();
          break;
      }
      controller.enqueue(chunk);
    },
  });
}

export function settleReasoningTimes(parts: unknown, now = Date.now) {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "reasoning" || !("providerMetadata" in part)) return part;
    const timing = readOrbitTiming(part.providerMetadata);
    if (!timing || timing.thoughtMs !== undefined || !part.providerMetadata || typeof part.providerMetadata !== "object") return part;
    const orbitTiming: OrbitTiming = { ...timing, thoughtMs: Math.max(0, now() - timing.startedAt) };
    return { ...part, providerMetadata: { ...part.providerMetadata, orbitTiming } };
  });
}

export function stripOrbitTiming(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => message.role === "assistant" ? {
    ...message,
    parts: message.parts.map((part) => {
      if (!("providerMetadata" in part) || !part.providerMetadata || !("orbitTiming" in part.providerMetadata)) return part;
      const { orbitTiming: _timing, ...rest } = part.providerMetadata;
      const { providerMetadata: _metadata, ...content } = part;
      return Object.keys(rest).length > 0 ? { ...content, providerMetadata: rest } : content;
    }),
  } : message);
}

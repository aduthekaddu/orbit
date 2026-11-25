import type { UIMessageChunk } from "ai";
import { type Redactor, type StreamRedactor } from "./chat-errors";

type TextEndChunk = Extract<UIMessageChunk, { type: "text-end" }>;
type TextStartChunk = Extract<UIMessageChunk, { type: "text-start" }>;
type ReasoningEndChunk = Extract<UIMessageChunk, { type: "reasoning-end" }>;
type ReasoningStartChunk = Extract<UIMessageChunk, { type: "reasoning-start" }>;

type ClosedSegment<S extends UIMessageChunk, E extends UIMessageChunk> = {
  id: string;
  start?: S;
  tail: string;
  end: E;
};

type DeltaChannel<S extends UIMessageChunk, E extends UIMessageChunk> = {
  kind: "text" | "reasoning";
  // Segments whose end chunk arrived, held briefly in case the next chunk opens another part of the same kind.
  closed: ClosedSegment<S, E>[];
  active: { id: string; start?: S; stream: StreamRedactor } | null;
  pendingBuffer: string;
};

function createChannel<S extends UIMessageChunk, E extends UIMessageChunk>(kind: "text" | "reasoning"): DeltaChannel<S, E> {
  return { kind, closed: [], active: null, pendingBuffer: "" };
}

function redactObjectField<T extends Record<string, unknown>>(chunk: T, redact: Redactor): T {
  const copy: Record<string, unknown> = { ...chunk };
  if ("providerMetadata" in copy && copy.providerMetadata !== undefined) copy.providerMetadata = redact.value(copy.providerMetadata);
  if ("toolMetadata" in copy && copy.toolMetadata !== undefined) copy.toolMetadata = redact.value(copy.toolMetadata);
  if ("messageMetadata" in copy && copy.messageMetadata !== undefined) copy.messageMetadata = redact.value(copy.messageMetadata);
  if ("title" in copy && typeof copy.title === "string") copy.title = redact.text(copy.title);
  if ("citations" in copy && copy.citations !== undefined) copy.citations = redact.value(copy.citations);
  return copy as T;
}

export function redactUIMessageStream(redact: Redactor): TransformStream<UIMessageChunk, UIMessageChunk> {
  const textChannel = createChannel<TextStartChunk, TextEndChunk>("text");
  const reasoningChannel = createChannel<ReasoningStartChunk, ReasoningEndChunk>("reasoning");
  const toolInputs = new Map<string, StreamRedactor>();
  const hold = redact.streamHoldback;

  const emitDelta = (
    controller: TransformStreamDefaultController<UIMessageChunk>,
    kind: "text" | "reasoning",
    id: string,
    delta: string,
  ) => {
    if (!delta) return;
    if (kind === "text") controller.enqueue({ type: "text-delta", id, delta });
    else controller.enqueue({ type: "reasoning-delta", id, delta });
  };

  const resolveClosedIntoActive = <S extends UIMessageChunk, E extends UIMessageChunk>(
    channel: DeltaChannel<S, E>,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    if (channel.closed.length === 0 || !channel.active) return;
    const segments = [...channel.closed.map((seg) => seg.tail), channel.pendingBuffer];
    const masked = redact.maskSegments(segments);
    for (let i = 0; i < channel.closed.length; i++) {
      const seg = channel.closed[i];
      if (seg.start) controller.enqueue(seg.start);
      emitDelta(controller, channel.kind, seg.id, masked[i]);
      controller.enqueue(seg.end);
    }
    channel.closed = [];
    if (channel.active.start) {
      controller.enqueue(channel.active.start);
      channel.active.start = undefined;
    }
    const nextText = masked[masked.length - 1];
    channel.pendingBuffer = "";
    const out = channel.active.stream.push(nextText);
    emitDelta(controller, channel.kind, channel.active.id, out);
  };

  const flushChannel = <S extends UIMessageChunk, E extends UIMessageChunk>(
    channel: DeltaChannel<S, E>,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    if (channel.closed.length > 0) {
      if (channel.active) {
        const segments = [...channel.closed.map((seg) => seg.tail), channel.pendingBuffer];
        const masked = redact.maskSegments(segments);
        for (let i = 0; i < channel.closed.length; i++) {
          const seg = channel.closed[i];
          if (seg.start) controller.enqueue(seg.start);
          emitDelta(controller, channel.kind, seg.id, masked[i]);
          controller.enqueue(seg.end);
        }
        channel.closed = [];
        if (channel.active.start) {
          controller.enqueue(channel.active.start);
          channel.active.start = undefined;
        }
        const tail = channel.active.stream.flush(masked[masked.length - 1]);
        emitDelta(controller, channel.kind, channel.active.id, tail);
        channel.active = null;
        channel.pendingBuffer = "";
        return;
      }
      const masked = redact.maskSegments(channel.closed.map((seg) => seg.tail));
      for (let i = 0; i < channel.closed.length; i++) {
        const seg = channel.closed[i];
        if (seg.start) controller.enqueue(seg.start);
        emitDelta(controller, channel.kind, seg.id, masked[i]);
        controller.enqueue(seg.end);
      }
      channel.closed = [];
      return;
    }
    if (channel.active) {
      if (channel.active.start) {
        controller.enqueue(channel.active.start);
        channel.active.start = undefined;
      }
      const tail = channel.active.stream.flush(channel.pendingBuffer);
      emitDelta(controller, channel.kind, channel.active.id, tail);
      channel.active = null;
      channel.pendingBuffer = "";
    }
  };

  const flushToolInput = (toolCallId: string, controller: TransformStreamDefaultController<UIMessageChunk>) => {
    const stream = toolInputs.get(toolCallId);
    if (!stream) return;
    toolInputs.delete(toolCallId);
    const tail = stream.flush();
    if (tail) controller.enqueue({ type: "tool-input-delta", toolCallId, inputTextDelta: tail });
  };

  const flushAll = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    flushChannel(textChannel, controller);
    flushChannel(reasoningChannel, controller);
    for (const toolCallId of [...toolInputs.keys()]) flushToolInput(toolCallId, controller);
  };

  const handleStart = <S extends TextStartChunk | ReasoningStartChunk, E extends TextEndChunk | ReasoningEndChunk>(
    channel: DeltaChannel<S, E>,
    chunk: S,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    const safe = redactObjectField(chunk, redact);
    if (channel.active) flushChannel(channel, controller);
    if (channel.closed.length > 0 && hold > 0) {
      channel.active = { id: safe.id, start: safe, stream: redact.createStream() };
      channel.pendingBuffer = "";
      return;
    }
    flushChannel(channel, controller);
    channel.active = { id: safe.id, stream: redact.createStream() };
    channel.pendingBuffer = "";
    controller.enqueue(safe);
  };

  const handleDelta = <S extends TextStartChunk | ReasoningStartChunk, E extends TextEndChunk | ReasoningEndChunk>(
    channel: DeltaChannel<S, E>,
    id: string,
    delta: string,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    if (!channel.active) {
      channel.active = { id, stream: redact.createStream() };
      channel.pendingBuffer = "";
    }
    if (channel.closed.length > 0) {
      channel.pendingBuffer += delta;
      // Once the new part has enough characters past the boundary, resolve the boundary and resume streaming.
      if (channel.pendingBuffer.length > hold * 6 + 64) {
        resolveClosedIntoActive(channel, controller);
      }
      return;
    }
    const out = channel.active.stream.push(delta);
    emitDelta(controller, channel.kind, channel.active.id, out);
  };

  const handleEnd = <S extends TextStartChunk | ReasoningStartChunk, E extends TextEndChunk | ReasoningEndChunk>(
    channel: DeltaChannel<S, E>,
    chunk: E,
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ) => {
    const safe = redactObjectField(chunk, redact);
    if (!channel.active) {
      flushChannel(channel, controller);
      controller.enqueue(safe);
      return;
    }
    if (hold === 0) {
      flushChannel(channel, controller);
      controller.enqueue(safe);
      return;
    }
    if (channel.closed.length > 0) {
      channel.closed.push({
        id: channel.active.id,
        start: channel.active.start,
        tail: channel.pendingBuffer,
        end: safe,
      });
      channel.active = null;
      channel.pendingBuffer = "";
      return;
    }
    const tail = channel.active.stream.takeTail();
    channel.closed.push({
      id: channel.active.id,
      tail,
      end: safe,
    });
    channel.active = null;
    channel.pendingBuffer = "";
  };

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      switch (chunk.type) {
        case "text-start":
          flushChannel(reasoningChannel, controller);
          handleStart(textChannel, chunk, controller);
          return;
        case "text-delta":
          handleDelta(textChannel, chunk.id, chunk.delta, controller);
          return;
        case "text-end":
          handleEnd(textChannel, chunk, controller);
          return;
        case "reasoning-start":
          flushChannel(textChannel, controller);
          handleStart(reasoningChannel, chunk, controller);
          return;
        case "reasoning-delta":
          handleDelta(reasoningChannel, chunk.id, chunk.delta, controller);
          return;
        case "reasoning-end":
          handleEnd(reasoningChannel, chunk, controller);
          return;
        case "tool-input-start": {
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          toolInputs.set(chunk.toolCallId, redact.createStream());
          controller.enqueue(redactObjectField(chunk, redact));
          return;
        }
        case "tool-input-delta": {
          let stream = toolInputs.get(chunk.toolCallId);
          if (!stream) {
            stream = redact.createStream();
            toolInputs.set(chunk.toolCallId, stream);
          }
          const out = stream.push(chunk.inputTextDelta);
          if (out) controller.enqueue({ ...chunk, inputTextDelta: out });
          return;
        }
        case "tool-input-available":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          flushToolInput(chunk.toolCallId, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            input: redact.value(chunk.input),
          });
          return;
        case "tool-input-error":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          flushToolInput(chunk.toolCallId, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            input: redact.value(chunk.input),
            errorText: redact.diagnostic(chunk.errorText),
          });
          return;
        case "tool-output-available":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            output: redact.value(chunk.output),
          });
          return;
        case "tool-output-error":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            errorText: redact.diagnostic(chunk.errorText),
          });
          return;
        case "tool-approval-request":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...chunk,
            ...(chunk.approvalDescriptor !== undefined ? { approvalDescriptor: redact.value(chunk.approvalDescriptor) } : {}),
            ...(chunk.inputSchemaInput !== undefined ? { inputSchemaInput: redact.value(chunk.inputSchemaInput) } : {}),
            ...(chunk.reason !== undefined ? { reason: redact.text(chunk.reason) } : {}),
          });
          return;
        case "tool-approval-response":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            ...(chunk.reason !== undefined ? { reason: redact.text(chunk.reason) } : {}),
          });
          return;
        case "error":
          flushAll(controller);
          controller.enqueue({ ...chunk, errorText: redact.diagnostic(chunk.errorText) });
          return;
        case "abort":
          flushAll(controller);
          controller.enqueue({
            ...chunk,
            ...(chunk.reason !== undefined ? { reason: redact.diagnostic(chunk.reason) } : {}),
          });
          return;
        case "source-url":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            url: redact.text(chunk.url),
          });
          return;
        case "source-document":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            ...(chunk.filename !== undefined ? { filename: redact.text(chunk.filename) } : {}),
          });
          return;
        case "file":
        case "reasoning-file":
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          controller.enqueue({
            ...redactObjectField(chunk, redact),
            url: redact.text(chunk.url),
          });
          return;
        case "steering-message":
          flushAll(controller);
          controller.enqueue({
            ...chunk,
            parts: redact.value(chunk.parts) as typeof chunk.parts,
          });
          return;
        case "start-step":
        case "finish-step":
        case "reset-step":
        case "finish":
          flushAll(controller);
          controller.enqueue(redactObjectField(chunk, redact));
          return;
        case "start":
        case "message-metadata":
        case "tool-output-denied":
        case "custom":
          controller.enqueue(redactObjectField(chunk, redact));
          return;
        default: {
          flushChannel(textChannel, controller);
          flushChannel(reasoningChannel, controller);
          const record = chunk as Record<string, unknown>;
          if ("data" in record) {
            controller.enqueue({ ...redactObjectField(record, redact), data: redact.value(record.data) } as UIMessageChunk);
            return;
          }
          controller.enqueue(redactObjectField(record, redact) as UIMessageChunk);
        }
      }
    },
    flush(controller) {
      flushAll(controller);
    },
  });
}

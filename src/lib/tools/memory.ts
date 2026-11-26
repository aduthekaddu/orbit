import { tool } from "ai";
import { z } from "zod";
import type { Redactor } from "../chat-errors";
import { cleanMemoryText, deleteMemory, MemoryRejected, saveMemory, type MemoryKind } from "../memory/store";

export type MemorySource = { chatId: string | null; messageId: string | null };

const kindSchema = z.enum(["fact", "preference", "summary"]);

function isForeignKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY");
}

export function rememberFact(
  source: MemorySource,
  input: { text: string; kind: MemoryKind },
  redact?: Redactor,
): { id: string; text: string } | { error: string } {
  let text = input.text;
  if (redact) {
    try {
      text = redact.text(cleanMemoryText(redact.text(input.text)));
    } catch (error) {
      if (error instanceof MemoryRejected) return { error: error.message };
      throw error;
    }
  }
  const attempts = [
    { chatId: source.chatId, messageId: source.messageId },
    { chatId: source.chatId, messageId: null },
    { chatId: null, messageId: null },
  ];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.chatId ?? ""}\0${attempt.messageId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const memory = saveMemory({
        text,
        kind: input.kind,
        source: "tool",
        sourceChatId: attempt.chatId,
        sourceMessageId: attempt.messageId,
      });
      return { id: memory.id, text: redact ? redact.text(memory.text) : memory.text };
    } catch (error) {
      if (error instanceof MemoryRejected) return { error: error.message };
      if (!isForeignKey(error)) return { error: "Could not save memory" };
    }
  }
  return { error: "Could not save memory" };
}

export function createRememberTool(source: MemorySource = { chatId: null, messageId: null }, redact?: Redactor) {
  return tool({
    description: "Save a lasting fact or preference the user stated, or something the user asked you to remember.",
    inputSchema: z.object({
      text: z.string().trim().min(1).max(500),
      kind: kindSchema.default("fact"),
    }),
    execute: ({ text, kind }) => rememberFact(source, { text, kind }, redact),
  });
}

export function forgetMemory(id: string): { id: string } | { error: string } {
  const trimmed = id.trim();
  if (!trimmed) return { error: "Memory id is required" };
  return deleteMemory(trimmed) ? { id: trimmed } : { error: "No memory with that id" };
}

export const forgetIdSchema = z.object({ id: z.string().trim().min(1).max(100) });

export function createForgetTool() {
  return tool({
    description: "Delete one saved memory. The id has to be one the user gave you. Do not invent an id.",
    inputSchema: forgetIdSchema,
    execute: ({ id }) => forgetMemory(id),
  });
}

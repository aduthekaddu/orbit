import { tool } from "ai";
import { z } from "zod";
import { deleteMemory, MemoryRejected, saveMemory, type MemoryKind } from "../memory/store";

export type MemorySource = { chatId: string | null; messageId: string | null };

const kindSchema = z.enum(["fact", "preference", "summary"]);

function rejected(error: unknown): { error: string } | null {
  if (error instanceof MemoryRejected) return { error: error.message };
  if (error && typeof error === "object" && "code" in error && error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return null;
  return { error: "Could not save memory" };
}

export function createRememberTool(source: MemorySource = { chatId: null, messageId: null }) {
  return tool({
    description: "Save a lasting fact or preference the user stated, or something the user asked you to remember.",
    inputSchema: z.object({
      text: z.string().trim().min(1).max(500),
      kind: kindSchema.default("fact"),
    }),
    execute: ({ text, kind }) => {
      const save = (withSource: boolean) =>
        saveMemory({
          text,
          kind: kind as MemoryKind,
          sourceChatId: withSource ? source.chatId : null,
          sourceMessageId: withSource ? source.messageId : null,
        });
      try {
        return { id: save(true).id };
      } catch (error) {
        const failure = rejected(error);
        if (failure) return failure;
        try {
          return { id: save(false).id };
        } catch (again) {
          return rejected(again) ?? { error: "Could not save memory" };
        }
      }
    },
  });
}

export function createForgetTool() {
  return tool({
    description: "Delete one saved memory by id.",
    inputSchema: z.object({ id: z.string().trim().min(1).max(100) }),
    execute: ({ id }) => (deleteMemory(id) ? { id } : { error: "No memory with that id" }),
  });
}

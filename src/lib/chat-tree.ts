import type { UIMessage } from "ai";

export type StoredMessage = UIMessage & { parentId: string | null };

export function pathTo(messages: StoredMessage[], headId: string | null): StoredMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: StoredMessage[] = [];
  const seen = new Set<string>();
  let id = headId;
  while (id !== null) {
    const message = byId.get(id);
    if (!message || seen.has(id)) return [];
    seen.add(id);
    path.push(message);
    id = message.parentId;
  }
  return path.reverse();
}

export function isPath(messages: Pick<StoredMessage, "id" | "parentId">[], incoming: { id: string }[]): boolean {
  const byId = new Map(messages.map((message) => [message.id, message]));
  let parentId: string | null = null;
  const seen = new Set<string>();
  for (const message of incoming) {
    const saved = byId.get(message.id);
    if (!saved || saved.parentId !== parentId || seen.has(message.id)) return false;
    seen.add(message.id);
    parentId = message.id;
  }
  return true;
}

export function toRepository(messages: StoredMessage[], headId: string | null) {
  return {
    headId,
    messages: messages.map(({ parentId, ...message }) => ({ parentId, message })),
  };
}

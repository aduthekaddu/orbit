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

export function focusedHead(
  messages: readonly { id: string; parentId: string | null }[],
  storedHeadId: string | null,
  messageId: string | null | undefined,
): string | null {
  if (!messageId) return storedHeadId;
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!byId.has(messageId)) return storedHeadId;
  const seen = new Set<string>();
  let id: string | null = messageId;
  while (id !== null) {
    if (seen.has(id)) return storedHeadId;
    seen.add(id);
    const message = byId.get(id);
    if (!message) return storedHeadId;
    id = message.parentId;
  }
  const active = new Set<string>();
  const seenActive = new Set<string>();
  id = storedHeadId;
  while (id !== null && !seenActive.has(id)) {
    seenActive.add(id);
    active.add(id);
    id = byId.get(id)?.parentId ?? null;
  }
  return active.has(messageId) ? storedHeadId : messageId;
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

import { focusedHead, type toRepository } from "../chat-tree";

type History = ReturnType<typeof toRepository>;

export function artifactHistory(history: History, key: string | undefined): History {
  const match = key && /^(.+)\.\d+\.\d+$/.exec(key);
  if (!match) return history;
  const id = match[1];
  if (!history.messages.some(({ message }) => message.id === id && message.role === "assistant")) return history;
  const rows = history.messages.map(({ message, parentId }) => ({ id: message.id, parentId }));
  const headId = focusedHead(rows, history.headId, id);
  return headId === history.headId ? history : { ...history, headId };
}

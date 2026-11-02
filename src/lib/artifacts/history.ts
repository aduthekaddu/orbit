import { pathTo, type toRepository } from "../chat-tree";

type History = ReturnType<typeof toRepository>;

export function artifactHistory(history: History, key: string | undefined): History {
  const match = key && /^(.+)\.\d+\.\d+$/.exec(key);
  if (!match) return history;
  const id = match[1];
  if (!history.messages.some(({ message }) => message.id === id && message.role === "assistant")) return history;
  const messages = history.messages.map(({ message, parentId }) => ({ ...message, parentId }));
  if (pathTo(messages, history.headId).some((message) => message.id === id)) return history;
  return { ...history, headId: id };
}

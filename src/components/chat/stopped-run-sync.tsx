"use client";

import { useEffect, useState } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { hasOpenCodeRun, restoreStoppedRuns } from "@/lib/chat-stopped-runs";

const POLL_MS = 250;
const POLL_LIMIT = 60;

// The server saves a stopped reply after the browser has already let go of the request, so ask until every one is there.
async function pollSavedReplies(chatId: string, ids: string[], signal: AbortSignal, onFound: (replies: UIMessage[]) => void) {
  for (let attempt = 0; attempt < POLL_LIMIT && !signal.aborted; attempt += 1) {
    const response = await fetch(`/api/chats/${chatId}`, { signal }).catch(() => null);
    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as { messages?: { message: UIMessage }[] } | null;
      const found = (body?.messages ?? []).map(({ message }) => message).filter((message) => ids.includes(message.id) && !hasOpenCodeRun(message));
      if (!signal.aborted) onFound(found);
      if (found.length === ids.length) return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Gives each stopped run card the result the server saved, so it matches what a reload shows.
// A version that was not on screen when its result arrived gets it when the branch picker shows it again.
export function StoppedRunSync({ chatId, stopped }: { chatId: string; stopped: string[] }) {
  const chat = useAISDKChat();
  const [saved, setSaved] = useState<UIMessage[]>([]);
  useEffect(() => {
    if (stopped.length === 0) return;
    const controller = new AbortController();
    void pollSavedReplies(chatId, stopped, controller.signal, (replies) => setSaved((known) => (replies.length > known.length ? replies : known)));
    return () => controller.abort();
  }, [chatId, stopped]);

  const messages = chat?.messages;
  const setMessages = chat?.setMessages;
  useEffect(() => {
    if (!messages || !setMessages || saved.reduce(restoreStoppedRuns, messages) === messages) return;
    setMessages((live) => saved.reduce(restoreStoppedRuns, live));
  }, [messages, saved, setMessages]);
  return null;
}

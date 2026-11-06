"use client";

import { useEffect } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { restoreStoppedRuns } from "@/lib/chat-stopped-runs";

const POLL_MS = 250;
const POLL_LIMIT = 60;

// The server saves a stopped reply after the browser has already let go of the request, so ask until it is there.
async function savedReply(chatId: string, messageId: string, signal: AbortSignal): Promise<UIMessage | null> {
  for (let attempt = 0; attempt < POLL_LIMIT && !signal.aborted; attempt += 1) {
    const response = await fetch(`/api/chats/${chatId}`, { signal }).catch(() => null);
    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as { messages?: { message: UIMessage }[] } | null;
      const saved = body?.messages?.find(({ message }) => message.id === messageId);
      if (saved) return saved.message;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

// Gives a run card the result the server saved when the user pressed Stop, so it matches what a reload shows.
export function StoppedRunSync({ chatId, stopped }: { chatId: string; stopped: UIMessage | null }) {
  const setMessages = useAISDKChat()?.setMessages;
  useEffect(() => {
    if (!stopped || !setMessages) return;
    const controller = new AbortController();
    void savedReply(chatId, stopped.id, controller.signal).then((saved) => {
      if (saved && !controller.signal.aborted) setMessages((live) => restoreStoppedRuns(live, saved));
    });
    return () => controller.abort();
  }, [chatId, stopped, setMessages]);
  return null;
}

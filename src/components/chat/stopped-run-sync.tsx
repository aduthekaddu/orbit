"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { z } from "zod";
import { hasOpenCodeRun, openCodeRunIds, restoreStoppedRuns } from "@/lib/chat-stopped-runs";
import { requestJson } from "@/lib/request-json";

const POLL_MS = 250;
const POLL_LIMIT = 60;

const savedMessage = z.looseObject({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
});
const savedChat = z.object({
  messages: z.array(z.object({ message: z.custom<UIMessage>((value) => savedMessage.safeParse(value).success) })),
});

// The server saves a stopped reply after the browser has already let go of the request, so ask until every one is there.
// Resolves with the ids still missing once a read fails or the attempts run out, [] once none is, or null when `signal` aborted.
export async function pollSavedReplies(chatId: string, ids: string[], signal: AbortSignal, onFound: (replies: UIMessage[]) => void): Promise<string[] | null> {
  let missing = ids;
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (signal.aborted) return null;
    let failed = false;
    await requestJson(`/api/chats/${chatId}`, { signal }, {
      parse: savedChat,
      onOk: (body) => {
        const found = body.messages.map(({ message }) => message).filter((message) => ids.includes(message.id) && !hasOpenCodeRun(message));
        onFound(found);
        missing = ids.filter((id) => !found.some((message) => message.id === id));
      },
      onFailed: () => {
        failed = true;
      },
    });
    if (signal.aborted) return null;
    if (failed || missing.length === 0) return missing;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return missing;
}

const NO_RUNS: ReadonlySet<string> = new Set();
export const UnloadedRuns = createContext(NO_RUNS);

// True for a stopped code run whose saved result the page could not load.
export function useRunResultUnloaded(toolCallId: string) {
  return useContext(UnloadedRuns).has(toolCallId);
}

// Gives each stopped run card the result the server saved, so it matches what a reload shows.
// A version that was not on screen when its result arrived gets it when the branch picker shows it again.
export function StoppedRunSync({ chatId, stopped, children }: { chatId: string; stopped: string[]; children: React.ReactNode }) {
  const chat = useAISDKChat();
  const [saved, setSaved] = useState<UIMessage[]>([]);
  const [unloaded, setUnloaded] = useState<string[]>([]);
  useEffect(() => {
    if (stopped.length === 0) return;
    const controller = new AbortController();
    void pollSavedReplies(chatId, stopped, controller.signal, (replies) => setSaved((known) => (replies.length > known.length ? replies : known))).then(
      (missing) => missing && setUnloaded(missing),
    );
    return () => controller.abort();
  }, [chatId, stopped]);

  const messages = chat?.messages;
  const setMessages = chat?.setMessages;
  useEffect(() => {
    if (!messages || !setMessages || saved.reduce(restoreStoppedRuns, messages) === messages) return;
    setMessages((live) => saved.reduce(restoreStoppedRuns, live));
  }, [messages, saved, setMessages]);

  const unloadedRuns = useMemo(
    () => (unloaded.length === 0 || !messages ? NO_RUNS : new Set(messages.filter((message) => unloaded.includes(message.id)).flatMap(openCodeRunIds))),
    [messages, unloaded],
  );
  return <UnloadedRuns.Provider value={unloadedRuns}>{children}</UnloadedRuns.Provider>;
}

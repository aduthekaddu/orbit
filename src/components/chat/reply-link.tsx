"use client";

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatOnFinishCallback, UIMessage } from "ai";
import { z } from "zod";
import { pathTo } from "@/lib/chat-tree";
import { requestJson } from "@/lib/request-json";

const RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 5_000];
const STOP_FALLBACK_MS = 1_500;

type Attached = { kind: "attached"; replyId: string | null };
type Reconnecting = { kind: "reconnecting"; replyId: string; attempt: number };
type StopRequest = { kind: "sending"; previous: Attached | Reconnecting } | { kind: "confirmed" };
type ReplyLinkState = Attached | Reconnecting
  | { kind: "stopping"; replyId: string; request: StopRequest }
  | { kind: "lost"; replyId: string };

type Snapshot = { state: ReplyLinkState; stopError: string };
type ResumeAttempt = { controller: AbortController; status?: number };

type Chat = Pick<UseChatHelpers<UIMessage>, "resumeStream" | "clearError" | "setMessages" | "stop">;
type Finish = Pick<Parameters<ChatOnFinishCallback<UIMessage>>[0], "isDisconnect" | "isAbort">;

const stoppedReply = z.object({ ok: z.literal(true), stopped: z.boolean() });
const savedMessage = z.looseObject({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
});
const savedChat = z.object({
  headId: z.string().nullable(),
  messages: z.array(z.object({
    parentId: z.string().nullable(),
    message: z.custom<UIMessage>((value) => savedMessage.safeParse(value).success),
  })),
});

function readCheckpoint(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCheckpoint(key: string, replyId: string | null) {
  try {
    if (replyId === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, replyId);
  } catch {
    // The in-memory checkpoint still works when a browser blocks storage.
  }
}

export function createReplyLink(chatId: string, refresh: () => void) {
  const key = `orbit-stream:${chatId}`;
  const api = `/api/chats/${encodeURIComponent(chatId)}`;
  const initial = { state: { kind: "attached", replyId: null }, stopError: "" } satisfies Snapshot;
  let snapshot: Snapshot = initial;
  const listeners = new Set<() => void>();
  let connection: { chat: Chat; controller: AbortController } | null = null;
  let attempt: ResumeAttempt | null = null;
  let mounted = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  function update(state: ReplyLinkState, stopError = snapshot.stopError) {
    snapshot = { state, stopError };
    for (const render of listeners) render();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const state = snapshot.state;
    if (state.kind !== "reconnecting" || !connection || attempt) return;
    retryTimer = setTimeout(() => void resume(), RETRY_MS[state.attempt] ?? RETRY_MS[RETRY_MS.length - 1]);
  }

  function lost(replyId: string) {
    writeCheckpoint(key, null);
    connection?.chat.clearError();
    update({ kind: "lost", replyId });
  }

  async function resume() {
    clearTimeout(retryTimer);
    const state = snapshot.state;
    const active = connection;
    if (state.kind !== "reconnecting" || !active || attempt ||
      navigator.onLine === false || document.visibilityState !== "visible") return;
    const request: ResumeAttempt = { controller: active.controller };
    attempt = request;
    try {
      await active.chat.resumeStream({ body: { replyId: state.replyId } });
      if (active.controller.signal.aborted || snapshot.state.kind !== "reconnecting") return;
      if (request.status === 204) {
        await requestJson(api, { signal: active.controller.signal }, {
          parse: savedChat,
          onOk: ({ messages, headId }) => {
            if (snapshot.state.kind !== "reconnecting") return;
            if (!messages.some(({ message }) => message.id === state.replyId)) {
              lost(state.replyId);
              return;
            }
            const path = pathTo(messages.map(({ message, parentId }) => ({ ...message, parentId })), headId);
            active.chat.setMessages(path.map(({ parentId: _parentId, ...message }) => message));
            active.chat.clearError();
            writeCheckpoint(key, null);
            update({ kind: "attached", replyId: null });
            refresh();
          },
          onFailed: (failure) => {
            if (snapshot.state.kind === "reconnecting" && failure.kind !== "network" &&
              !(failure.kind === "http" && failure.status >= 500)) lost(state.replyId);
          },
        });
      } else if (request.status && request.status >= 400 && request.status < 500 && request.status !== 429) {
        lost(state.replyId);
      }
      if (snapshot.state.kind === "reconnecting" && snapshot.state.replyId === state.replyId) {
        update({ kind: "reconnecting", replyId: state.replyId, attempt: snapshot.state.attempt + 1 });
      }
    } finally {
      attempt = null;
      scheduleRetry();
    }
  }

  function wake() {
    void resume();
  }

  function accept(replyId: string) {
    writeCheckpoint(key, replyId);
    update({ kind: "attached", replyId }, "");
  }

  function finish({ isDisconnect, isAbort }: Finish) {
    if (!connection || isAbort) return;
    clearTimeout(stopTimer);
    const { state } = snapshot;
    if (isDisconnect && state.replyId && state.kind !== "lost") {
      const retry: Reconnecting = { kind: "reconnecting", replyId: state.replyId, attempt: 0 };
      if (state.kind === "stopping" && state.request.kind === "sending") {
        update({ ...state, request: { kind: "sending", previous: retry } });
      } else {
        update(retry);
        scheduleRetry();
      }
      return;
    }
    writeCheckpoint(key, null);
    update({ kind: "attached", replyId: null });
    refresh();
  }

  function reconnectResponse(status: number) {
    if (!attempt || attempt.controller.signal.aborted) return;
    attempt.status = status;
    if (status === 200) {
      connection?.chat.clearError();
      const { state } = snapshot;
      if (state.kind === "reconnecting") update({ kind: "attached", replyId: state.replyId });
      if (state.kind === "stopping" && state.request.kind === "sending") {
        update({ ...state, request: { kind: "sending", previous: { kind: "attached", replyId: state.replyId } } });
      }
    }
  }

  async function stop() {
    const active = connection;
    const { state } = snapshot;
    if (!active || (state.kind !== "attached" && state.kind !== "reconnecting") || !state.replyId) return;
    const { replyId } = state;
    clearTimeout(retryTimer);
    update({ kind: "stopping", replyId, request: { kind: "sending", previous: state } }, "");
    await requestJson(`${api}/stop`, { method: "POST", signal: active.controller.signal }, {
      parse: stoppedReply,
      onOk: ({ stopped }) => {
        const { state: current } = snapshot;
        if (current.kind !== "stopping" || current.request.kind !== "sending" || current.replyId !== replyId) return;
        if (current.request.previous.kind === "reconnecting") {
          update(current.request.previous);
          wake();
          return;
        }
        if (!stopped) {
          void active.chat.stop();
          writeCheckpoint(key, null);
          update({ kind: "attached", replyId: null });
          refresh();
          return;
        }
        update({ kind: "stopping", replyId, request: { kind: "confirmed" } });
        stopTimer = setTimeout(() => {
          update({ kind: "reconnecting", replyId, attempt: 0 });
          void active.chat.stop().then(wake);
        }, STOP_FALLBACK_MS);
      },
      onFailed: () => {
        const { state: current } = snapshot;
        if (current.kind !== "stopping" || current.request.kind !== "sending" || current.replyId !== replyId) return;
        update(current.request.previous, "Could not stop");
        scheduleRetry();
      },
    });
  }

  return {
    accept,
    finish,
    reconnectResponse,
    stop,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect(chat: Chat) {
      const controller = new AbortController();
      connection = { chat, controller };
      window.addEventListener("online", wake, { signal: controller.signal });
      document.addEventListener("visibilitychange", wake, { signal: controller.signal });
      scheduleRetry();
      return () => {
        controller.abort();
        connection = null;
        clearTimeout(retryTimer);
        clearTimeout(stopTimer);
        if (attempt?.controller === controller) {
          const { state } = snapshot;
          if (state.kind === "attached" && state.replyId) {
            update({ kind: "reconnecting", replyId: state.replyId, attempt: 0 });
          }
          void chat.stop();
        }
      };
    },
    mount(liveReplyId: string | null, savedIds: ReadonlySet<string>, restorePending: boolean) {
      if (mounted) return;
      mounted = true;
      if (snapshot.state.kind !== "attached" || snapshot.state.replyId) return;
      const stored = readCheckpoint(key);
      if (stored && savedIds.has(stored)) writeCheckpoint(key, null);
      const replyId = liveReplyId ?? (restorePending ? stored : null);
      if (!replyId || savedIds.has(replyId)) return;
      writeCheckpoint(key, replyId);
      update({ kind: "reconnecting", replyId, attempt: 0 });
      wake();
    },
  };
}

type Link = ReturnType<typeof createReplyLink>;
const ReplyLinkContext = createContext<Link | null>(null);
const noSubscribe = () => () => {};
const emptySnapshot: Snapshot = { state: { kind: "attached", replyId: null }, stopError: "" };
const getEmptySnapshot = () => emptySnapshot;

export function useReplyLink() {
  const link = useContext(ReplyLinkContext);
  const { state, stopError } = useSyncExternalStore(
    link?.subscribe ?? noSubscribe,
    link?.getSnapshot ?? getEmptySnapshot,
    link?.getServerSnapshot ?? getEmptySnapshot,
  );
  return { kind: state.kind, stopError, canStop: (state.kind === "attached" || state.kind === "reconnecting") && Boolean(state.replyId), stop: link?.stop };
}

export function ReplyLink({
  link, historyLoaded, headId, liveReplyId, savedIds, restorePending, children,
}: {
  link: Link;
  historyLoaded: boolean;
  headId: string | null;
  liveReplyId: string | null;
  savedIds: ReadonlySet<string>;
  restorePending: boolean;
  children: ReactNode;
}) {
  const chat = useAISDKChat();
  const { resumeStream, clearError, setMessages, stop } = chat ?? {};
  const headLoaded = useAuiState((state) =>
    !state.thread.isLoading && (headId === null || state.thread.messages.some((message) => message.id === headId)),
  );

  useEffect(() => {
    if (!resumeStream || !clearError || !setMessages || !stop) return;
    return link.connect({ resumeStream, clearError, setMessages, stop });
  }, [link, resumeStream, clearError, setMessages, stop]);

  useEffect(() => {
    if (historyLoaded && headLoaded && resumeStream) link.mount(liveReplyId, savedIds, restorePending);
  }, [link, historyLoaded, headLoaded, resumeStream, liveReplyId, savedIds, restorePending]);

  return <ReplyLinkContext.Provider value={link}>{children}</ReplyLinkContext.Provider>;
}

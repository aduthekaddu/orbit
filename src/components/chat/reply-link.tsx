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

type Attached = { kind: "attached"; replyId: string };
type Reconnecting = { kind: "reconnecting"; replyId: string; attempt: number };
type ActiveReply = Attached | Reconnecting;
type IdleOrActive = ActiveReply | { kind: "attached"; replyId: null } | { kind: "lost"; replyId: string };
type ReplyLinkState = IdleOrActive
  | { kind: "stopping"; reply: IdleOrActive; request: "sending" | "confirmed" };

type Snapshot = { state: ReplyLinkState; stopError: string; clockOffsetMs: number };
type ResumeAttempt = { signal: AbortSignal; controller: AbortController; target: Reconnecting; status?: number };
type ReplyDiscovery = { kind: "initial" | "idle" } | { kind: "awaiting-reply"; promptId: string };

function activeReply(state: ReplyLinkState): ActiveReply | null {
  const reply = state.kind === "stopping" ? state.reply : state;
  if (reply.kind === "reconnecting" || (reply.kind === "attached" && reply.replyId !== null)) return reply;
  return null;
}

type Chat = Pick<UseChatHelpers<UIMessage>, "resumeStream" | "clearError" | "setMessages" | "stop">;
type Finish = Pick<Parameters<ChatOnFinishCallback<UIMessage>>[0], "isDisconnect" | "isAbort" | "messages">;

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

export function createReplyLink(chatId: string, refresh: () => void, now = Date.now) {
  const key = `orbit-stream:${chatId}`;
  const api = `/api/chats/${encodeURIComponent(chatId)}`;
  const initial = { state: { kind: "attached", replyId: null }, stopError: "", clockOffsetMs: 0 } satisfies Snapshot;
  let snapshot: Snapshot = initial;
  const listeners = new Set<() => void>();
  let connection: { chat: Chat; controller: AbortController } | null = null;
  let attempt: ResumeAttempt | null = null;
  let discovery: ReplyDiscovery = { kind: "initial" };
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  function update(state: ReplyLinkState, stopError = activeReply(state) ? snapshot.stopError : "") {
    snapshot = { ...snapshot, state, stopError };
    for (const render of listeners) render();
  }

  function syncClock(serverTime: number) {
    const clockOffsetMs = now() - serverTime;
    if (snapshot.clockOffsetMs === clockOffsetMs) return;
    snapshot = { ...snapshot, clockOffsetMs };
    for (const render of listeners) render();
  }

  function updateReply(reply: ActiveReply) {
    const { state } = snapshot;
    update(state.kind === "stopping" ? { ...state, reply } : reply);
  }

  function reconnecting() {
    const { state } = snapshot;
    if (state.kind === "stopping" && state.request === "sending") return null;
    const reply = activeReply(state);
    return reply?.kind === "reconnecting" ? reply : null;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const reply = reconnecting();
    if (!reply || !connection || attempt) return;
    retryTimer = setTimeout(wake, RETRY_MS[reply.attempt] ?? RETRY_MS[RETRY_MS.length - 1]);
  }

  function settle(state: { kind: "attached"; replyId: null } | { kind: "lost"; replyId: string }) {
    writeCheckpoint(key, null);
    update(state);
  }

  function lost(replyId: string) {
    connection?.chat.clearError();
    settle({ kind: "lost", replyId });
  }

  async function resume() {
    clearTimeout(retryTimer);
    const target = reconnecting();
    const active = connection;
    if (!target || !active || attempt ||
      navigator.onLine === false || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    const signal = AbortSignal.any([active.controller.signal, controller.signal]);
    const request: ResumeAttempt = { signal, controller, target };
    const { replyId } = target;
    const stillReconnecting = () => !signal.aborted && reconnecting()?.replyId === replyId;
    attempt = request;
    try {
      await active.chat.resumeStream({ body: { replyId } });
      if (!stillReconnecting()) return;
      if (request.status === 204) {
        await requestJson(api, { signal }, {
          parse: savedChat,
          onOk: ({ messages, headId }) => {
            if (!stillReconnecting()) return;
            if (!messages.some(({ message }) => message.id === replyId)) {
              lost(replyId);
              return;
            }
            const path = pathTo(messages.map(({ message, parentId }) => ({ ...message, parentId })), headId);
            active.chat.setMessages(path.map(({ parentId: _parentId, ...message }) => message));
            active.chat.clearError();
            settle({ kind: "attached", replyId: null });
            refresh();
          },
          onFailed: (failure) => {
            if (stillReconnecting() && failure.kind !== "network" &&
              !(failure.kind === "http" && failure.status >= 500)) lost(replyId);
          },
        });
      } else if (request.status && request.status >= 400 && request.status < 500 && request.status !== 429) {
        lost(replyId);
      }
      if (stillReconnecting()) updateReply({ ...target, attempt: target.attempt + 1 });
    } finally {
      attempt = null;
      scheduleRetry();
    }
  }

  function wake() {
    if (discovery.kind === "awaiting-reply" && connection &&
        navigator.onLine && document.visibilityState === "visible") {
      refresh();
      return;
    }
    void resume();
  }

  function accept(replyId: string) {
    discovery = { kind: "idle" };
    writeCheckpoint(key, replyId);
    if (snapshot.state.kind === "stopping") {
      update({ ...snapshot.state, reply: { kind: "attached", replyId } }, "");
      return;
    }
    update({ kind: "attached", replyId }, "");
  }

  function finish({ isDisconnect, isAbort, messages }: Finish) {
    if (!connection || isAbort) return;
    clearTimeout(stopTimer);
    const reply = activeReply(snapshot.state);
    if (isDisconnect && reply) {
      updateReply({ kind: "reconnecting", replyId: reply.replyId, attempt: attempt?.target.attempt ?? 0 });
      scheduleRetry();
      return;
    }
    if (snapshot.state.kind === "stopping") {
      if (isDisconnect && snapshot.state.request === "sending") return;
      discovery = { kind: "idle" };
      settle({ kind: "attached", replyId: null });
      refresh();
      return;
    }
    const prompt = isDisconnect ? messages.findLast((message) => message.role === "user") : undefined;
    discovery = prompt ? { kind: "awaiting-reply", promptId: prompt.id } : { kind: "idle" };
    settle({ kind: "attached", replyId: null });
    refresh();
  }

  function reconnectResponse(status: number) {
    if (!attempt || attempt.signal.aborted) return;
    attempt.status = status;
    if (status === 200) {
      const reply = activeReply(snapshot.state);
      if (reply?.kind === "reconnecting" && reply.replyId === attempt.target.replyId) {
        connection?.chat.clearError();
        updateReply({ kind: "attached", replyId: reply.replyId });
      }
    }
  }

  function replaceStream(chat: Chat) {
    attempt?.controller.abort();
    void chat.stop().then(wake);
  }

  function armStopFallback(chat: Chat) {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      const reply = activeReply(snapshot.state);
      if (reply) {
        updateReply({ kind: "reconnecting", replyId: reply.replyId, attempt: attempt?.target.attempt ?? 0 });
        replaceStream(chat);
        return;
      }
      if (snapshot.state.kind !== "stopping") return;
      discovery = { kind: "idle" };
      void chat.stop();
      settle({ kind: "attached", replyId: null });
      refresh();
    }, STOP_FALLBACK_MS);
  }

  async function stop() {
    const active = connection;
    const { state } = snapshot;
    if (!active || state.kind === "stopping") return;
    let targetState: IdleOrActive = state;
    for (;;) {
      const replyId = activeReply(targetState)?.replyId ?? null;
      const next: { reply: ActiveReply | null } = { reply: null };
      clearTimeout(retryTimer);
      update({ kind: "stopping", reply: targetState, request: "sending" }, "");
      await requestJson(`${api}/stop`, { method: "POST", signal: active.controller.signal }, {
        parse: stoppedReply,
        onOk: ({ stopped }) => {
          const { state: current } = snapshot;
          if (current.kind !== "stopping" || current.request !== "sending") return;
          const currentReply = activeReply(current);
          if (replyId !== null && currentReply?.replyId !== replyId) return;
          if (!stopped && replyId === null && currentReply !== null) {
            next.reply = currentReply;
            return;
          }
          if (!stopped && currentReply?.kind !== "reconnecting") {
            discovery = { kind: "idle" };
            void active.chat.stop();
            settle({ kind: "attached", replyId: null });
            refresh();
            return;
          }
          update({ ...current, request: "confirmed" });
          if (currentReply?.kind === "reconnecting") {
            if (attempt) replaceStream(active.chat);
            else wake();
            return;
          }
          armStopFallback(active.chat);
        },
        onFailed: () => {
          const { state: current } = snapshot;
          if (current.kind !== "stopping" || current.request !== "sending") return;
          if (replyId !== null && activeReply(current)?.replyId !== replyId) return;
          update(current.reply, "Could not stop");
          scheduleRetry();
        },
      });
      if (!next.reply) return;
      targetState = next.reply;
    }
  }

  return {
    accept,
    finish,
    reconnectResponse,
    syncClock,
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
        if (connection?.controller !== controller) return;
        connection = null;
        clearTimeout(retryTimer);
        clearTimeout(stopTimer);
        if (attempt?.signal.aborted) {
          const reply = activeReply(snapshot.state);
          if (reply?.kind === "attached") {
            updateReply({ kind: "reconnecting", replyId: reply.replyId, attempt: attempt.target.attempt });
          }
          void chat.stop();
        }
      };
    },
    mount(liveReplyId: string | null, savedIds: ReadonlySet<string>, restorePending: boolean, headId: string | null) {
      const initial = discovery.kind === "initial";
      if (!initial && (discovery.kind !== "awaiting-reply" || !liveReplyId || discovery.promptId !== headId)) return;
      if (initial) discovery = { kind: "idle" };
      if (snapshot.state.kind !== "attached" || snapshot.state.replyId) return;
      const stored = initial ? readCheckpoint(key) : null;
      if (stored && savedIds.has(stored)) writeCheckpoint(key, null);
      const replyId = liveReplyId ?? (restorePending ? stored : null);
      if (!replyId || savedIds.has(replyId)) return;
      discovery = { kind: "idle" };
      writeCheckpoint(key, replyId);
      update({ kind: "reconnecting", replyId, attempt: 0 });
      wake();
    },
  };
}

type Link = ReturnType<typeof createReplyLink>;
const ReplyLinkContext = createContext<Link | null>(null);
const noSubscribe = () => () => {};
const emptySnapshot: Snapshot = { state: { kind: "attached", replyId: null }, stopError: "", clockOffsetMs: 0 };
const getEmptySnapshot = () => emptySnapshot;

export function useReplyLink() {
  const link = useContext(ReplyLinkContext);
  const { state, stopError, clockOffsetMs } = useSyncExternalStore(
    link?.subscribe ?? noSubscribe,
    link?.getSnapshot ?? getEmptySnapshot,
    link?.getServerSnapshot ?? getEmptySnapshot,
  );
  return { kind: state.kind, stopError, clockOffsetMs, canStop: link !== null && state.kind !== "stopping", stop: link?.stop };
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
    !state.thread.isLoading && !state.thread.isRunning && (headId === null || state.thread.messages.some((message) => message.id === headId)),
  );

  useEffect(() => {
    if (!resumeStream || !clearError || !setMessages || !stop) return;
    return link.connect({ resumeStream, clearError, setMessages, stop });
  }, [link, resumeStream, clearError, setMessages, stop]);

  useEffect(() => {
    if (historyLoaded && headLoaded && resumeStream) link.mount(liveReplyId, savedIds, restorePending, headId);
  }, [link, historyLoaded, headLoaded, resumeStream, liveReplyId, savedIds, restorePending, headId]);

  return <ReplyLinkContext.Provider value={link}>{children}</ReplyLinkContext.Provider>;
}

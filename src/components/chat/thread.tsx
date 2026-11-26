"use client";

import { useEffect, useRef, useState } from "react";
import { ThreadPrimitive, useAui, useAuiEvent, useAuiState } from "@assistant-ui/react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { Figure } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "./composer";
import { messageByRole } from "./messages";
import { ThreadMap } from "./thread-map";

const STARTERS = [
  { label: "Make a table", prompt: "Make a table comparing " },
  { label: "Explain code", prompt: "Explain this code:\n\n" },
  { label: "Summarize", prompt: "Summarize this in five bullets:\n\n" },
  { label: "Brainstorm", prompt: "Give me ten ideas for " },
];

// The runtime loads saved messages in an effect after hydration, and its isLoading turns false once before that load
// starts, so until the first message arrives the layout follows what the server saw: saved messages or none.
type ThreadView = "empty" | "loading" | "messages";

export function Thread({ ready, model, focusMessageId, hasHistory }: { ready: boolean; model: string; focusMessageId?: string | null; hasHistory: boolean }) {
  const view = useAuiState((state): ThreadView => (state.thread.messages.length > 0 ? "messages" : hasHistory ? "loading" : "empty"));
  const [autoScroll, setAutoScroll] = useState(!focusMessageId);
  useAuiEvent("thread.runStart", () => setAutoScroll(true));
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = viewport.current;
    if (!focusMessageId || view !== "messages" || !root) return;
    let ring: number | undefined;
    const focus = () => {
      const el = root.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`);
      if (!(el instanceof HTMLElement)) return;
      observer.disconnect();
      el.scrollIntoView({ block: "center" });
      el.style.boxShadow = "0 0 0 2px var(--sun)";
      ring = window.setTimeout(() => {
        el.style.boxShadow = "";
      }, 1600);
    };
    const observer = new MutationObserver(focus);
    observer.observe(root, { childList: true, subtree: true });
    focus();
    return () => {
      observer.disconnect();
      window.clearTimeout(ring);
    };
  }, [view, focusMessageId]);
  return (
    <TooltipProvider>
      <ThreadPrimitive.Root className="@container/thread relative flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport
          ref={viewport}
          scrollToBottomOnInitialize={!focusMessageId}
          autoScroll={autoScroll}
          className="@container flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-8 scrollbar-thin"
        >
          {view === "empty" ? (
            <EmptyState model={model} />
          ) : (
            <>
              <div className="flex flex-col gap-6">
                {view === "loading" ? (
                  <MessagesSkeleton />
                ) : (
                  <ThreadPrimitive.Messages>
                    {({ message }) => {
                      const Message = messageByRole[message.role];
                      return <Message />;
                    }}
                  </ThreadPrimitive.Messages>
                )}
              </div>
              <ThreadPrimitive.ViewportFooter className="pointer-events-none sticky bottom-0 mt-auto bg-gradient-to-t from-background from-60% pt-8 pb-4">
                <div className="pointer-events-auto relative mx-auto w-full max-w-chat">
                  {view === "messages" && (
                    <ThreadPrimitive.ScrollToBottom
                      aria-label="Scroll to bottom"
                      className="absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-popover text-muted-foreground shadow-float transition-opacity duration-200 ease-orbit hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
                    >
                      <ArrowDownIcon weight="regular" className="size-4" />
                    </ThreadPrimitive.ScrollToBottom>
                  )}
                  <Composer ready={ready} model={model} />
                </div>
              </ThreadPrimitive.ViewportFooter>
            </>
          )}
        </ThreadPrimitive.Viewport>
        {view === "messages" ? <ThreadMap viewport={viewport} /> : null}
      </ThreadPrimitive.Root>
    </TooltipProvider>
  );
}

function MessagesSkeleton() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-chat justify-end">
        <Skeleton className="h-10 w-2/5 rounded-2xl" />
      </div>
      <div className="mx-auto flex w-full max-w-chat flex-col gap-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </>
  );
}

// An empty chat centers the figure and the composer as one group; the composer drops to the bottom on the first send.
function EmptyState({ model }: { model: string }) {
  const aui = useAui();
  const input = useRef<HTMLTextAreaElement>(null);

  function start(prompt: string) {
    input.current?.focus();
    aui.composer.setText(prompt);
    requestAnimationFrame(() => input.current?.setSelectionRange(prompt.length, prompt.length));
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-[12vh]">
      <div className="w-64 max-w-[70%]">
        <Figure name="dish" />
      </div>
      <div className="mt-8 w-full max-w-chat animate-rise">
        <Composer ready model={model} inputRef={input} />
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {STARTERS.map((starter) => (
            <Button
              key={starter.label}
              variant="outline"
              size="sm"
              onClick={() => start(starter.prompt)}
              className="rounded-full font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:px-4"
            >
              {starter.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

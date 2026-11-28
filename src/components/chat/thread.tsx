"use client";

import { useEffect, useRef, useState } from "react";
import { ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
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

// turnAnchor="top" scrolls a prompt taller than `tallerThan` so only its last `visibleHeight` stays in view, and it
// measures the whole user message. On touch that holds the 44px Copy and Edit row and its 6px gap under the bubble,
// about 3.125em, so the touch clamp adds that to both defaults (10em and 6em): the same prompts clamp as with a mouse,
// and the same part of the bubble stays in view instead of one cut line above the actions.
const TOUCH_ANCHOR_CLAMP = { tallerThan: "13.125em", visibleHeight: "9.125em" };

// assistant-ui reads the clamp once, when the viewport mounts. It writes no markup, so reading the pointer in a state
// initializer keeps the server render and hydration the same.
function anchorClamp() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? TOUCH_ANCHOR_CLAMP : undefined;
}

// The runtime loads saved messages in an effect after hydration, and its isLoading turns false once before that load
// starts, so until the first message arrives the layout follows what the server saw: saved messages or none.
type ThreadView = "empty" | "loading" | "messages";

export function Thread({ ready, needsOwnConnection, focusMessageId, hasHistory }: { ready: boolean; needsOwnConnection: boolean; focusMessageId?: string | null; hasHistory: boolean }) {
  const view = useAuiState((state): ThreadView => (state.thread.messages.length > 0 ? "messages" : hasHistory ? "loading" : "empty"));
  // Saved messages open at the bottom, except a ?m= search hit, which centers. A chat that started empty skips that
  // first scroll: its first prompt is already at the top, and assistant-ui never anchors the first message, so the
  // scroll would follow the first reply down. Fixed at mount: hasHistory turns true when the finished reply
  // refreshes the page, and assistant-ui would run the first-load scroll then. ChatPanel remounts per chat and ?m=.
  const [scrollToBottomOnLoad] = useState(hasHistory && !focusMessageId);
  const viewport = useRef<HTMLDivElement>(null);
  const [clamp] = useState(anchorClamp);
  // The thread map puts its Prompts button here when the rail does not fit and the header is hidden.
  const [promptsSlot, setPromptsSlot] = useState<HTMLElement | null>(null);
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
        {/* turnAnchor="top" scrolls each new prompt to the top once and never follows the reply down, so the reader
            starts at the beginning of the answer. */}
        <ThreadPrimitive.Viewport
          ref={viewport}
          turnAnchor="top"
          topAnchorMessageClamp={clamp}
          scrollToBottomOnInitialize={scrollToBottomOnLoad}
          className="@container flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-8 scrollbar-thin"
        >
          {view === "empty" ? (
            <EmptyState />
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
              {/* Below the fade everything is opaque, and the strip holds its height while messages load and while the
                  button is hidden, so text never shows behind the button and the composer never moves. */}
              <ThreadPrimitive.ViewportFooter className="pointer-events-none sticky bottom-0 mt-auto">
                <div aria-hidden className="h-4 bg-gradient-to-t from-background to-transparent" />
                <div className="pointer-events-auto bg-background pb-[max(1rem,env(safe-area-inset-bottom))]">
                  <div data-jump-strip className="relative flex h-11 items-center justify-center bg-background">
                    {view === "messages" && (
                      <ThreadPrimitive.ScrollToBottom
                        data-scroll-to-bottom
                        className="flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1.5 text-meta text-muted-foreground shadow-card transition-opacity duration-200 ease-orbit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-0"
                      >
                        <ArrowDownIcon weight="regular" className="size-3.5" />
                        Jump to latest
                      </ThreadPrimitive.ScrollToBottom>
                    )}
                    <div ref={setPromptsSlot} className="absolute inset-y-0 right-0 flex items-center" />
                  </div>
                  <div className="mx-auto w-full max-w-chat">
                    <Composer ready={ready} needsOwnConnection={needsOwnConnection} />
                  </div>
                </div>
              </ThreadPrimitive.ViewportFooter>
            </>
          )}
        </ThreadPrimitive.Viewport>
        {view === "messages" ? <ThreadMap viewport={viewport} stripSlot={promptsSlot} /> : null}
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
function EmptyState() {
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
        <Composer ready inputRef={input} />
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

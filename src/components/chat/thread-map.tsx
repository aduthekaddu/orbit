"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { currentTurnIndex, shortcutTarget, turnLabel, visibleTurns, type Turn } from "@/lib/thread-map";

const MIN_TURNS = 3;

export function ThreadMap({ viewport }: { viewport: RefObject<HTMLElement | null> }) {
  const messages = useAuiState((state) => state.thread.messages);
  const turns = useMemo<Turn[]>(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          text: turnLabel(message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")),
        })),
    [messages],
  );
  const [position, setPosition] = useState({ current: 0, visible: [] as boolean[] });

  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      const tops = turns.map((turn) => {
        const element = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`);
        return element ? element.getBoundingClientRect().top - rootTop + root.scrollTop : Number.POSITIVE_INFINITY;
      });
      const viewTop = root.scrollTop;
      const viewBottom = viewTop + root.clientHeight;
      const atEnd = viewBottom >= root.scrollHeight - 2;
      setPosition({
        current: atEnd ? turns.length - 1 : currentTurnIndex(tops, viewTop + root.clientHeight * 0.3),
        visible: visibleTurns(tops, root.scrollHeight, viewTop, viewBottom),
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    root.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    if (root.firstElementChild) resize.observe(root.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule);
      resize.disconnect();
    };
  }, [turns, viewport]);

  function jump(index: number) {
    const turn = turns[Math.max(0, Math.min(turns.length - 1, index))];
    if (!turn) return;
    const target = viewport.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    // Focus follows the jump, which also closes the panel the click came from.
    target.focus({ preventScroll: true });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = shortcutTarget(event, position.current, turns.length);
      if (target === null) return;
      event.preventDefault();
      jump(target);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (turns.length < MIN_TURNS) return null;

  return (
    <nav
      aria-label="Prompts in this chat"
      className="group/map absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 @[52rem]/thread:block"
    >
      <ol className="flex max-h-[60vh] flex-col items-end gap-2 overflow-hidden py-2 pr-1 pl-4">
        {turns.map((turn, index) => (
          <li key={turn.id} className="flex h-0.5 items-center">
            <span
              className={cn(
                "block h-0.5 rounded-full transition-[width,background-color] duration-200 ease-orbit",
                index === position.current
                  ? "w-5 bg-sun"
                  : position.visible[index]
                    ? "w-4 bg-foreground/70"
                    : "w-3 bg-muted-foreground/35",
              )}
            />
          </li>
        ))}
      </ol>
      <div className="pointer-events-none invisible absolute top-1/2 right-full w-72 -translate-y-1/2 translate-x-1 pr-2 opacity-0 transition-[opacity,translate,visibility] duration-150 ease-orbit group-focus-within/map:pointer-events-auto group-focus-within/map:visible group-focus-within/map:translate-x-0 group-focus-within/map:opacity-100 group-hover/map:pointer-events-auto group-hover/map:visible group-hover/map:translate-x-0 group-hover/map:opacity-100">
        <ul className="max-h-[60vh] overflow-y-auto rounded-xl border bg-popover p-1 shadow-float scrollbar-thin">
          {turns.map((turn, index) => (
            <li key={turn.id}>
              <button
                type="button"
                onClick={() => jump(index)}
                aria-current={index === position.current ? "location" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors duration-150 ease-orbit hover:bg-accent focus-visible:bg-accent",
                  index === position.current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", index === position.current ? "bg-sun" : "bg-transparent")}
                />
                <span className="truncate">{turn.text || "Untitled"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

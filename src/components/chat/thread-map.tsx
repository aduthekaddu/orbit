"use client";

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAuiState } from "@assistant-ui/react";
import { ListBulletsIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { currentTurnIndex, shortcutTarget, turnLabel, visibleTurns, type Turn } from "@/lib/thread-map";
import { useHeaderSlot } from "@/components/shell/header-slot";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

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
  const current = position.current;
  const [open, setOpen] = useState(false);
  const [hoverDismissed, setHoverDismissed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetPick = useRef<number | null>(null);
  const sheetList = useRef<HTMLUListElement>(null);
  const headerSlot = useHeaderSlot();
  const trigger = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const panelId = useId();

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

  useEffect(() => {
    const list = rail.current;
    if (!list) return;
    const keep = () => {
      const tick = list.children[current];
      if (!(tick instanceof HTMLElement)) return;
      const listBox = list.getBoundingClientRect();
      const tickBox = tick.getBoundingClientRect();
      if (tickBox.top < listBox.top) list.scrollTop += tickBox.top - listBox.top;
      else if (tickBox.bottom > listBox.bottom) list.scrollTop += tickBox.bottom - listBox.bottom;
    };
    keep();
    const resize = new ResizeObserver(keep);
    resize.observe(list);
    return () => resize.disconnect();
  }, [current, turns.length]);

  function jump(index: number) {
    const turn = turns[Math.max(0, Math.min(turns.length - 1, index))];
    if (!turn) return;
    const target = viewport.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`);
    if (!target) return;
    setOpen(false);
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (sheetOpen) return;
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches("input, textarea, select"))) return;
      const target = shortcutTarget(event, current, turns.length);
      if (target === null) return;
      event.preventDefault();
      jump(target);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (turns.length < MIN_TURNS) return null;

  return (
    <>
      <nav
        aria-label="Prompts in this chat"
        className="group/map absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 @[52rem]/thread:block"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
        onPointerLeave={() => setHoverDismissed(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          const hovering = event.currentTarget.matches(":hover");
          if (!open && (!hovering || hoverDismissed)) return;
          event.preventDefault();
          setHoverDismissed(hovering);
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <button
          ref={trigger}
          type="button"
          aria-label="Prompts"
          aria-expanded={open}
          aria-controls={panelId}
          onFocus={(event) => {
            const fromRail = event.currentTarget.parentElement?.contains(event.relatedTarget);
            if (!fromRail && event.currentTarget.matches(":focus-visible")) setOpen(true);
          }}
          onClick={(event) => setOpen(event.detail === 0 || !open)}
          className="absolute -top-4 right-0 h-4 w-5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <ol
          ref={rail}
          tabIndex={-1}
          className="flex max-h-[60vh] flex-col items-end gap-2 overflow-y-auto py-2 pr-1 pl-4 scrollbar-none"
        >
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
        <div
          id={panelId}
          className={cn(
            "absolute top-1/2 right-full w-72 -translate-y-1/2 pr-2 transition-[opacity,translate,visibility] duration-150 ease-orbit",
            open
              ? "visible translate-x-0 opacity-100"
              : cn(
                  "pointer-events-none invisible translate-x-1 opacity-0",
                  !hoverDismissed &&
                    "group-hover/map:pointer-events-auto group-hover/map:visible group-hover/map:translate-x-0 group-hover/map:opacity-100",
                ),
          )}
        >
          <PromptList
            turns={turns}
            current={position.current}
            onPick={jump}
            className="max-h-[60vh] overflow-y-auto rounded-xl border bg-popover p-1 shadow-float scrollbar-thin"
          />
        </div>
      </nav>
      {/* Phones have no room for the rail, so a header button opens the same list in a bottom sheet. A pick closes the
          sheet first and jumps once focus is free to leave it, so the prompt keeps focus instead of the header button. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        {headerSlot
          ? createPortal(
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Prompts" className="text-muted-foreground hover:text-foreground md:hidden">
                  <ListBulletsIcon weight="light" className="size-[18px]" />
                </Button>
              </SheetTrigger>,
              headerSlot,
            )
          : null}
        <SheetContent
          onOpenAutoFocus={() => {
            // Scroll only the list, so a long chat opens on the current prompt.
            const list = sheetList.current;
            const row = list?.querySelector<HTMLElement>('[aria-current="location"]');
            if (!list || !row) return;
            const listBox = list.getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();
            list.scrollTop += rowBox.top - listBox.top - (listBox.height - rowBox.height) / 2;
          }}
          onCloseAutoFocus={(event) => {
            const index = sheetPick.current;
            if (index === null) return;
            sheetPick.current = null;
            event.preventDefault();
            jump(index);
          }}
        >
          <SheetTitle className="px-4 pt-4 pb-2">Prompts</SheetTitle>
          <PromptList
            turns={turns}
            current={position.current}
            onPick={(index) => {
              sheetPick.current = index;
              setSheetOpen(false);
            }}
            listRef={sheetList}
            className="min-h-0 overflow-y-auto px-2 pb-2 scrollbar-thin"
            rowClassName="min-h-touch"
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function PromptList({
  turns,
  current,
  onPick,
  listRef,
  className,
  rowClassName,
}: {
  turns: Turn[];
  current: number;
  onPick: (index: number) => void;
  listRef?: RefObject<HTMLUListElement | null>;
  className: string;
  rowClassName?: string;
}) {
  return (
    <ul ref={listRef} className={className}>
      {turns.map((turn, index) => (
        <li key={turn.id}>
          <button
            type="button"
            onClick={() => onPick(index)}
            aria-current={index === current ? "location" : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors duration-150 ease-orbit hover:bg-accent focus-visible:bg-accent",
              index === current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              rowClassName,
            )}
          >
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", index === current ? "bg-sun" : "bg-transparent")} />
            <span className="truncate">{turn.text || "Untitled"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

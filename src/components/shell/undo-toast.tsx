"use client";

import { useEffect, useRef, useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UNDO_MS } from "./chat-delete";

// A failure stays on screen this long.
const ALERT_MS = 5_000;

const surface = "flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 shadow-float animate-rise";

/** Top center, under the 44px header on phones. Mount it inside an open modal so the modal does not hide it. */
export function Notices({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+3.5rem)] left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 md:top-[max(0.75rem,env(safe-area-inset-top))] *:pointer-events-auto">
      {children}
    </div>
  );
}

/**
 * Counts down UNDO_MS for each new `subject`, then calls `onExpire`. The countdown pauses while the toast reports
 * hover or focus, and keeps its remaining time when the toast moves between the drawer and the page.
 */
export function useUndoCountdown<T extends object>(subject: T | null, onExpire: (subject: T) => void) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(UNDO_MS);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  useEffect(() => {
    remaining.current = UNDO_MS;
  }, [subject]);
  useEffect(() => {
    if (!subject || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => expire.current(subject), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [subject, paused]);
  return setPaused;
}

export function UndoToast({ onUndo, onPausedChange }: { onUndo: () => void; onPausedChange: (paused: boolean) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const report = useRef(onPausedChange);
  useEffect(() => {
    report.current = onPausedChange;
  });
  useEffect(() => {
    report.current(hovered || focused);
  }, [hovered, focused]);
  // Hover and focus end with this copy of the toast.
  useEffect(() => () => report.current(false), []);

  return (
    <div
      role="status"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={cn(surface, "py-1.5 pr-1.5 text-sm")}
    >
      <span className="px-1">Chat deleted</span>
      <Button variant="ghost" size="xs" onClick={onUndo} className="text-sm">
        Undo
      </Button>
    </div>
  );
}

/** A failure line that dismisses itself after ALERT_MS. Key it by the failure so a new one restarts the time. */
export function TimedAlert({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => done.current(), ALERT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="alert" className={cn(surface, "text-meta text-destructive")}>
      <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

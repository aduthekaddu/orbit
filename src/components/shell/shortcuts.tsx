"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";

const shortcuts = {
  palette: { key: "k", shift: false },
  newChat: { key: "o", shift: true },
  sidebar: { key: "b", shift: false },
} as const;

export type ShortcutName = keyof typeof shortcuts;

const noSubscribe = () => () => {};

export function useIsMac() {
  return useSyncExternalStore(
    noSubscribe,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  );
}

export function useShortcuts(handlers: Record<ShortcutName, () => void>) {
  const isMac = useIsMac();
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey) return;
      for (const [name, shortcut] of Object.entries(shortcuts) as [ShortcutName, (typeof shortcuts)[ShortcutName]][]) {
        if (event.key.toLowerCase() === shortcut.key && event.shiftKey === shortcut.shift) {
          event.preventDefault();
          latest.current[name]();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac]);
}

export function ShortcutKbd({ name, className }: { name: ShortcutName; className?: string }) {
  const isMac = useIsMac();
  const { key, shift } = shortcuts[name];
  const label = isMac
    ? `⌘${shift ? "⇧" : ""}${key.toUpperCase()}`
    : `Ctrl ${shift ? "Shift " : ""}${key.toUpperCase()}`;
  return <Kbd className={cn("pointer-coarse:hidden", className)}>{label}</Kbd>;
}

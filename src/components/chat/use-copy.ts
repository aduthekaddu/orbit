"use client";

import { useEffect, useRef, useState } from "react";

export const COPIED_MS = 1500;

type ClipboardWriter = { writeText(text: string): Promise<void> };

export async function copyText(clipboard: ClipboardWriter | undefined, text: string): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCopy() {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(text: string) {
    void copyText(navigator.clipboard, text).then((ok) => {
      setStatus(ok ? "copied" : "failed");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), COPIED_MS);
    });
  }

  return { copied: status === "copied", failed: status === "failed", copy };
}

"use client";

import { useSyncExternalStore, type Ref } from "react";
import Link from "next/link";
import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const roundAction =
  "flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,color,scale] duration-150 ease-orbit hover:bg-primary/90 enabled:active:scale-90 disabled:bg-surface-raised disabled:text-muted-foreground/60";

const noSubscribe = () => () => {};

export function Composer({ ready, model, inputRef }: { ready: boolean; model: string; inputRef?: Ref<HTMLTextAreaElement> }) {
  const canCompose = useSyncExternalStore(noSubscribe, () => ready, () => false);
  return (
    <ComposerPrimitive.Root
      className={cn(
        "rounded-2xl border bg-card shadow-card transition-[border-color,background-color] duration-200 ease-orbit focus-within:border-border-strong focus-within:bg-popover",
        !ready && "border-dashed bg-transparent shadow-none",
      )}
    >
      <ComposerPrimitive.Input
        ref={inputRef}
        placeholder="Ask anything"
        rows={1}
        disabled={!canCompose}
        autoFocus={canCompose}
        className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm leading-6 outline-none scrollbar-thin placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:placeholder:text-muted-foreground/50"
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        {model ? (
          <Link
            href="/settings"
            className="min-w-0 rounded-full border px-2 py-0.5 font-mono text-2xs text-muted-foreground transition-colors duration-150 ease-orbit hover:border-border-strong hover:text-foreground"
          >
            <span className="block truncate">{model}</span>
          </Link>
        ) : (
          <span />
        )}
        <AuiIf condition={(state) => state.thread.isRunning}>
          <ComposerPrimitive.Cancel aria-label="Stop" className={roundAction}>
            <StopIcon weight="fill" className="size-3.5" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <AuiIf condition={(state) => !state.thread.isRunning}>
          <ComposerPrimitive.Send aria-label="Send" disabled={!canCompose} className={roundAction}>
            <ArrowUpIcon weight="regular" className="size-4" />
          </ComposerPrimitive.Send>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
}

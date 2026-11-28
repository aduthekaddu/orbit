"use client";

import { useSyncExternalStore, type Ref } from "react";
import Link from "next/link";
import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelChip } from "./model-picker";
import { useReplyLink } from "./reply-link";

const roundAction =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,color,scale] duration-150 ease-orbit hover:bg-primary/90 enabled:active:scale-90 disabled:bg-surface-raised disabled:text-muted-foreground/60";

const noSubscribe = () => () => {};

export function Composer({ ready, needsOwnConnection = false, inputRef }: { ready: boolean; needsOwnConnection?: boolean; inputRef?: Ref<HTMLTextAreaElement> }) {
  const canCompose = useSyncExternalStore(noSubscribe, () => ready, () => false);
  const reply = useReplyLink();
  const reconnecting = reply.kind === "reconnecting";
  const stopping = reply.kind === "stopping";
  return (
    <ComposerPrimitive.Root
      className={cn(
        "rounded-2xl border bg-card shadow-card transition-[border-color,background-color] duration-200 ease-orbit focus-within:border-border-strong focus-within:bg-popover",
        !ready && "border-dashed bg-transparent shadow-none",
      )}
    >
      {needsOwnConnection && <p className="px-4 pt-3 text-sm text-muted-foreground">Connect your own provider to keep chatting.</p>}
      <ComposerPrimitive.Input
        ref={inputRef}
        data-chat-composer=""
        placeholder="Ask anything"
        rows={1}
        disabled={!canCompose}
        autoFocus={canCompose}
        className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-field outline-none scrollbar-thin placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:placeholder:text-muted-foreground/50"
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        {needsOwnConnection ? (
          <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
            <Link href="/settings#connections">Add connection</Link>
          </Button>
        ) : <ModelChip />}
        {reply.stopError && <p role="alert" className="text-meta text-destructive">{reply.stopError}</p>}
        <AuiIf condition={(state) => state.thread.isRunning || reconnecting || stopping}>
          <button type="button" aria-label="Stop" className={roundAction} disabled={!reply.canStop} onClick={() => void reply.stop?.()}>
            <StopIcon weight="fill" className="size-3.5" />
          </button>
        </AuiIf>
        <AuiIf condition={(state) => !state.thread.isRunning && !reconnecting && !stopping}>
          <ComposerPrimitive.Send aria-label="Send" disabled={!canCompose} className={roundAction}>
            <ArrowUpIcon weight="regular" className="size-4" />
          </ComposerPrimitive.Send>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
}

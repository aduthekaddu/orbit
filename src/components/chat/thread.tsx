"use client";

import Link from "next/link";
import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { Figure } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "./composer";
import { messageByRole } from "./messages";

export function Thread({ ready, model }: { ready: boolean; model: string }) {
  return (
    <TooltipProvider>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport className="@container flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-8 scrollbar-thin">
          <AuiIf condition={(state) => state.thread.isEmpty}>{ready ? <EmptyState /> : <NoProvider />}</AuiIf>
          <div className="flex flex-col gap-6">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                const Message = messageByRole[message.role];
                return <Message />;
              }}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-60% pt-8 pb-4">
            <div className="relative mx-auto w-full max-w-widget">
              <ThreadPrimitive.ScrollToBottom
                aria-label="Scroll to bottom"
                className="absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-popover text-muted-foreground shadow-float transition-opacity duration-200 ease-orbit hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
              >
                <ArrowDownIcon weight="regular" className="size-4" />
              </ThreadPrimitive.ScrollToBottom>
              <Composer ready={ready} model={model} />
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </TooltipProvider>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 pb-8">
      <div className="w-60">
        <Figure name="dish" />
      </div>
      <p className="text-sm text-muted-foreground">What&apos;s on your mind?</p>
    </div>
  );
}

function NoProvider() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 pb-8">
      <div className="w-60">
        <Figure name="plug" />
      </div>
      <Button asChild size="sm">
        <Link href="/settings">Open settings</Link>
      </Button>
    </div>
  );
}

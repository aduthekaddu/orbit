"use client";

import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";

export function Thread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-6">
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-60% pt-6 pb-4">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border bg-card p-2">
      <ComposerPrimitive.Input
        placeholder="Message"
        rows={1}
        className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
      />
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <SquareIcon className="size-3.5" />
        </ComposerPrimitive.Cancel>
      </AuiIf>
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30">
          <ArrowUpIcon className="size-4" />
        </ComposerPrimitive.Send>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-3xl justify-end">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto w-full max-w-3xl text-sm">
      <MessagePrimitive.Parts />
      <MessagePrimitive.Error />
    </MessagePrimitive.Root>
  );
}

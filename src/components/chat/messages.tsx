"use client";

import type { ComponentType } from "react";
import {
  ActionBarPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  type EmptyMessagePartComponent,
  type MessagePrimitive as MessagePrimitiveTypes,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import { ArrowClockwiseIcon, CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { OrbitMark } from "@/components/orbit-mark";
import { IconAction, iconActionClass } from "./icon-action";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { COPIED_MS } from "./use-copy";

type PartComponents = NonNullable<MessagePrimitiveTypes.Parts.Props["components"]>;

const Pending: EmptyMessagePartComponent = ({ status }) => {
  if (status.type !== "running") return null;
  return (
    <div className="flex h-6 items-center">
      <span role="status" className="sr-only">
        Thinking
      </span>
      <div className="shimmer h-2 w-40 rounded-full" />
    </div>
  );
};

const PlainText: TextMessagePartComponent = ({ text }) => <>{text}</>;

const assistantParts: PartComponents = { Text: () => <MarkdownText />, Reasoning, Empty: Pending };

const userParts: PartComponents = { Text: PlainText };

function CopyAction() {
  return (
    <IconAction label="Copy">
      <ActionBarPrimitive.Copy copiedDuration={COPIED_MS} className={`group/copy ${iconActionClass}`}>
        <CopyIcon className="group-data-copied/copy:hidden" />
        <CheckIcon className="hidden group-data-copied/copy:block" />
      </ActionBarPrimitive.Copy>
    </IconAction>
  );
}

function AssistantMessage() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  return (
    <MessagePrimitive.Root className="relative mx-auto w-full max-w-widget animate-rise">
      <OrbitMark busy={running} className="absolute top-0.5 -left-9 hidden size-5 @3xl:block" />
      <MessagePrimitive.Parts components={assistantParts} />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-3 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <WarningCircleIcon weight="regular" className="mt-px size-3.5 shrink-0" />
          <ErrorPrimitive.Message className="min-w-0 break-words" />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <div className="mt-1 -ml-1.5 h-7">
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex gap-0.5">
          <CopyAction />
          <IconAction label="Regenerate">
            <ActionBarPrimitive.Reload className={iconActionClass}>
              <ArrowClockwiseIcon />
            </ActionBarPrimitive.Reload>
          </IconAction>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-widget animate-rise items-end justify-end gap-1.5">
      <ActionBarPrimitive.Root autohide="always">
        <CopyAction />
      </ActionBarPrimitive.Root>
      <div className="max-w-[85%] rounded-2xl border bg-surface-raised px-3.5 py-2 text-sm leading-6 break-words whitespace-pre-wrap">
        <MessagePrimitive.Parts components={userParts} />
      </div>
    </MessagePrimitive.Root>
  );
}

export const messageByRole: Record<"user" | "assistant" | "system", ComponentType> = {
  user: UserMessage,
  assistant: AssistantMessage,
  system: () => null,
};

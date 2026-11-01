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
import { cn } from "@/lib/utils";
import { OrbitMark } from "@/components/orbit-mark";
import { Button } from "@/components/ui/button";
import { IconAction, iconActionClass } from "./icon-action";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { RenderUiPart } from "@/components/genui/render-ui";
import { RENDER_UI_TOOL } from "@/lib/genui/catalog";
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

const assistantParts: PartComponents = { Text: () => <MarkdownText />, Reasoning, Empty: Pending, tools: { by_name: { [RENDER_UI_TOOL]: RenderUiPart } } };

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
  const failed = useAuiState((s) => s.message.status?.type === "incomplete" && s.message.status.reason === "error");
  const hasText = useAuiState((s) => s.message.content.some((part) => part.type === "text" && part.text.length > 0));
  return (
    <MessagePrimitive.Root className="relative mx-auto w-full max-w-widget animate-rise">
      <OrbitMark busy={running} tone={running ? "accent" : "mono"} className="absolute top-0.5 -left-9 hidden size-5 @3xl:block" />
      <MessagePrimitive.Parts components={assistantParts} />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-3 flex items-start gap-2 text-sm leading-6 text-destructive first:mt-0">
          <WarningCircleIcon weight="regular" className="mt-1 size-4 shrink-0" />
          <ErrorPrimitive.Message className="min-w-0 break-words" />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <div className={cn("mt-1 -ml-1.5 h-7", failed && "mt-2 ml-0")}>
        <ActionBarPrimitive.Root hideWhenRunning autohide={failed ? "never" : "not-last"} className="flex gap-0.5">
          {hasText && <CopyAction />}
          {failed ? (
            <ActionBarPrimitive.Reload asChild>
              <Button variant="outline" size="xs">
                <ArrowClockwiseIcon weight="regular" />
                Retry
              </Button>
            </ActionBarPrimitive.Reload>
          ) : (
            <IconAction label="Regenerate">
              <ActionBarPrimitive.Reload className={iconActionClass}>
                <ArrowClockwiseIcon />
              </ActionBarPrimitive.Reload>
            </IconAction>
          )}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  const id = useAuiState((state) => state.message.id);
  return (
    <MessagePrimitive.Root data-turn-id={id} tabIndex={-1} className="mx-auto flex w-full scroll-mt-6 outline-none max-w-widget animate-rise items-end justify-end gap-1.5">
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

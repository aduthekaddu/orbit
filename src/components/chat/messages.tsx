"use client";

import { useState, type ComponentType } from "react";
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  type EmptyMessagePartComponent,
  type MessagePrimitive as MessagePrimitiveTypes,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import { ArrowClockwiseIcon, CheckIcon, CopyIcon, PencilSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { OrbitMark } from "@/components/orbit-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { IconAction, iconActionClass } from "./icon-action";
import { MarkdownText } from "./markdown-text";
import { MessageTextEditor } from "./message-editor";
import { Reasoning } from "./reasoning";
import { RenderUiPart } from "@/components/genui/render-ui";
import { RENDER_UI_TOOL } from "@/lib/genui/catalog";
import { useCoarsePointer } from "./use-coarse-pointer";
import { useEditTarget } from "./chat-id";
import { BranchPicker } from "./branch-picker";
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

const assistantParts: PartComponents = { Text: () => <MarkdownText editable />, Reasoning, Empty: Pending, tools: { by_name: { [RENDER_UI_TOOL]: RenderUiPart } } };

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

function EditAction({ onClick, label = "Edit reply" }: { onClick: () => void; label?: string }) {
  return (
    <IconAction label={label}>
      <button type="button" aria-label={label} onClick={onClick} className={iconActionClass}>
        <PencilSimpleIcon />
      </button>
    </IconAction>
  );
}

function AssistantMessage() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const failed = useAuiState((s) => s.message.status?.type === "incomplete" && s.message.status.reason === "error");
  const messageId = useAuiState((s) => s.message.id);
  const text = useAuiState((s) =>
    s.message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  );
  const [editing, setEditing] = useState(false);
  const touch = useCoarsePointer();

  return (
    <MessagePrimitive.Root data-message-role="assistant" data-message-id={messageId} className="relative mx-auto w-full max-w-widget animate-rise">
      <OrbitMark busy={running} tone={running ? "accent" : "mono"} className="absolute top-0.5 -left-9 hidden size-5 @3xl:block" />
      {editing ? (
        <MessageTextEditor messageId={messageId} initialText={text} onClose={() => setEditing(false)} label="Edit reply" />
      ) : (
        <>
          <MessagePrimitive.Parts components={assistantParts} />
          <MessagePrimitive.Error>
            <ErrorPrimitive.Root className="mt-3 flex items-start gap-2 text-sm leading-6 text-destructive first:mt-0">
              <WarningCircleIcon weight="regular" className="mt-1 size-4 shrink-0" />
              <ErrorPrimitive.Message className="min-w-0 break-words" />
            </ErrorPrimitive.Root>
          </MessagePrimitive.Error>
        </>
      )}
      {!editing && (
        <div className={cn("mt-1 -ml-1.5 h-7", failed && "mt-2 ml-0")}>
          <ActionBarPrimitive.Root hideWhenRunning autohide={failed || touch ? "never" : "not-last"} className="flex gap-0.5">
            {text && <CopyAction />}
            {text && !failed && <EditAction onClick={() => setEditing(true)} />}
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
      )}
      <BranchPicker />
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  const editing = useAuiState((s) => s.message.composer.isEditing);
  const touch = useCoarsePointer();
  if (editing) return <UserEditComposer />;
  return (
    <MessagePrimitive.Root data-turn-id={id} data-message-id={id} tabIndex={-1} className="mx-auto flex w-full scroll-mt-6 outline-none max-w-widget animate-rise flex-col items-end gap-1.5">
      <div className="flex w-full items-end justify-end gap-1.5">
        <ActionBarPrimitive.Root autohide={touch ? "never" : "always"} className="flex">
          <CopyAction />
          <IconAction label="Edit">
            <ActionBarPrimitive.Edit className={iconActionClass}>
              <PencilSimpleIcon />
            </ActionBarPrimitive.Edit>
          </IconAction>
        </ActionBarPrimitive.Root>
        <div className="max-w-[85%] rounded-2xl border bg-surface-raised px-3.5 py-2 text-sm leading-6 break-words whitespace-pre-wrap">
          <MessagePrimitive.Parts components={userParts} />
        </div>
      </div>
      <BranchPicker />
    </MessagePrimitive.Root>
  );
}

// The edit keeps the bubble's shape and place, so it reads as changing this message, not writing a new one.
function UserEditComposer() {
  const id = useAuiState((s) => s.message.id);
  const editTarget = useEditTarget();
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-widget animate-rise justify-end">
      <ComposerPrimitive.Root onSubmit={() => editTarget(id)} className="flex max-w-[85%] min-w-64 flex-col overflow-hidden rounded-2xl border border-primary/40 bg-surface-raised">
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          cancelOnEscape
          aria-label="Edit message"
          className="block max-h-60 max-w-full resize-none bg-transparent px-3.5 pt-2 text-sm leading-6 outline-none field-sizing-content scrollbar-thin"
        />
        <div className="flex items-center justify-end gap-1 px-2 py-2">
          <ComposerPrimitive.Cancel onClick={() => editTarget(null)} className={buttonVariants({ variant: "ghost", size: "xs" })}>Cancel</ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className={buttonVariants({ size: "xs" })}>Send</ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

export const messageByRole: Record<"user" | "assistant" | "system", ComponentType> = {
  user: UserMessage,
  assistant: AssistantMessage,
  system: () => null,
};

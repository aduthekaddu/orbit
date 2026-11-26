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
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { ArrowClockwiseIcon, CheckIcon, CopyIcon, PencilSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { OrbitMark } from "@/components/orbit-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { IconAction, iconActionClass } from "./icon-action";
import { MarkdownText } from "./markdown-text";
import { MessageTextEditor } from "./message-editor";
import { Reasoning } from "./reasoning";
import { ReplyEnd } from "./reply-end";
import { useReplyLink } from "./reply-link";
import { RunCard } from "@/components/tools/run-card";
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

const assistantParts: PartComponents = {
  Text: () => <MarkdownText editable />,
  Reasoning,
  Empty: Pending,
  tools: { Override: RunCard },
  data: { by_name: { "reply-end": ReplyEnd } },
};

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

// The bar always renders so Tab reaches it. With a mouse it shows on hover, and at once on focus.
const hoverActionsClass =
  "transition-opacity duration-150 ease-orbit pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 focus-within:opacity-100 focus-within:transition-none";

function EditAction({ onClick, label = "Edit reply" }: { onClick: () => void; label?: string }) {
  return (
    <IconAction label={label}>
      <button type="button" aria-label={label} onClick={onClick} className={iconActionClass}>
        <PencilSimpleIcon />
      </button>
    </IconAction>
  );
}

function ReplyStatus({ kind }: { kind: "reconnecting" | "lost" }) {
  return (
    <p role="status" className="mt-2 text-meta text-muted-foreground">
      {kind === "reconnecting" ? "Reconnecting" : "Interrupted"}
    </p>
  );
}

function AssistantMessage() {
  const reply = useReplyLink();
  const running = useAuiState((s) => s.message.status?.type === "running");
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const sdkFailed = useAuiState((s) => s.message.status?.type === "incomplete" && s.message.status.reason === "error");
  const last = useAuiState((s) => s.message.isLast);
  const reconnecting = last && reply.kind === "reconnecting";
  const lost = last && !threadRunning && reply.kind === "lost";
  const failed = sdkFailed || lost;
  const busy = reply.kind === "reconnecting" || reply.kind === "stopping";
  const messageId = useAuiState((s) => s.message.id);
  const text = useAuiState((s) =>
    s.message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  );
  const [editing, setEditing] = useState(false);

  return (
    <MessagePrimitive.Root data-message-role="assistant" data-message-id={messageId} className="group/message relative mx-auto w-full max-w-chat animate-rise">
      <OrbitMark busy={running} tone={running ? "accent" : "mono"} className="absolute top-0.5 -left-9 hidden size-5 @3xl:block" />
      {editing ? (
        <MessageTextEditor messageId={messageId} initialText={text} onClose={() => setEditing(false)} label="Edit reply" />
      ) : (
        <>
          <MessagePrimitive.Parts components={assistantParts} />
          {reconnecting || lost ? (
            <ReplyStatus kind={reconnecting ? "reconnecting" : "lost"} />
          ) : (
            <MessagePrimitive.Error>
              <ErrorPrimitive.Root className="mt-3 flex items-start gap-2 text-sm leading-6 text-destructive first:mt-0">
                <WarningCircleIcon weight="regular" className="mt-1 size-4 shrink-0" />
                <ErrorPrimitive.Message className="min-w-0 break-words" />
              </ErrorPrimitive.Root>
            </MessagePrimitive.Error>
          )}
        </>
      )}
      {!editing && !busy && (
        <div className={cn("mt-1 -ml-1.5 h-7", failed && "mt-2 ml-0")}>
          <ActionBarPrimitive.Root hideWhenRunning className={cn("flex gap-0.5", !last && !failed && hoverActionsClass)}>
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
  const reply = useReplyLink();
  const chat = useAISDKChat();
  const running = useAuiState((s) => s.thread.isRunning);
  const busy = running || reply.kind === "reconnecting" || reply.kind === "stopping";
  const id = useAuiState((s) => s.message.id);
  const last = useAuiState((s) => s.message.isLast);
  const editing = useAuiState((s) => s.message.composer.isEditing);
  const reconnecting = last && reply.kind === "reconnecting";
  const lost = last && !running && reply.kind === "lost";
  if (editing) return <UserEditComposer busy={busy} />;
  return (
    <MessagePrimitive.Root data-turn-id={id} data-message-id={id} tabIndex={-1} className="group/message mx-auto flex w-full scroll-mt-6 outline-none max-w-chat animate-rise flex-col items-end gap-1.5">
      <div className="flex w-full items-end justify-end gap-1.5">
        <ActionBarPrimitive.Root className={cn("flex", hoverActionsClass)}>
          <CopyAction />
          <IconAction label="Edit">
            <ActionBarPrimitive.Edit disabled={busy} className={iconActionClass}>
              <PencilSimpleIcon />
            </ActionBarPrimitive.Edit>
          </IconAction>
        </ActionBarPrimitive.Root>
        <div className="max-w-[85%] rounded-2xl border bg-surface-raised px-3.5 py-2 text-prose break-words whitespace-pre-wrap">
          <MessagePrimitive.Parts components={userParts} />
        </div>
      </div>
      <BranchPicker />
      {(reconnecting || lost) && <ReplyStatus kind={reconnecting ? "reconnecting" : "lost"} />}
      {lost && (
        <Button variant="outline" size="xs" onClick={() => void chat?.regenerate({ messageId: id })}>
          <ArrowClockwiseIcon weight="regular" />
          Retry
        </Button>
      )}
    </MessagePrimitive.Root>
  );
}

// The edit keeps the bubble's shape and place, so it reads as changing this message, not writing a new one.
function UserEditComposer({ busy }: { busy: boolean }) {
  const id = useAuiState((s) => s.message.id);
  const editTarget = useEditTarget();
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-chat animate-rise justify-end">
      <ComposerPrimitive.Root
        onSubmit={(event) => {
          if (busy) return event.preventDefault();
          editTarget(id);
        }}
        className="flex max-w-[85%] min-w-64 flex-col overflow-hidden rounded-2xl border border-primary/40 bg-surface-raised"
      >
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          cancelOnEscape
          disabled={busy}
          aria-label="Edit message"
          className="block max-h-60 max-w-full resize-none bg-transparent px-3.5 pt-2 text-input outline-none field-sizing-content scrollbar-thin"
        />
        <div className="flex items-center justify-end gap-1 px-2 py-2">
          <ComposerPrimitive.Cancel onClick={() => editTarget(null)} className={buttonVariants({ variant: "ghost", size: "xs" })}>Cancel</ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send disabled={busy} className={buttonVariants({ size: "xs" })}>Send</ComposerPrimitive.Send>
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

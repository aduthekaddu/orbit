"use client";

import { useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
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
import { ReplyLabel } from "./reply-label";
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
      {!editing && (
        <div className={cn("mt-1 -ml-1.5 flex min-h-7 items-center pointer-coarse:min-h-11", failed && "mt-2 ml-0")}>
          {busy ? null : (
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
          )}
          <ReplyLabel />
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
  // One wrapping row, so placement is CSS only and nothing shifts after hydration. With a mouse the actions sit beside
  // the bubble, which leaves them 4rem so it never wraps under them, and the branch picker wraps below. On touch the
  // bubble takes the first line, and the branch picker and the 44px actions share the line under it, so the actions
  // take no width from the text.
  return (
    <MessagePrimitive.Root data-turn-id={id} data-message-id={id} tabIndex={-1} className="group/message mx-auto flex w-full scroll-mt-6 outline-none max-w-chat animate-rise flex-col items-end gap-1.5">
      <div className="flex w-full flex-wrap items-end justify-end gap-1.5">
        <ActionBarPrimitive.Root className={cn("flex pointer-coarse:order-last", hoverActionsClass)}>
          <CopyAction />
          <IconAction label="Edit">
            <ActionBarPrimitive.Edit disabled={busy} className={iconActionClass}>
              <PencilSimpleIcon />
            </ActionBarPrimitive.Edit>
          </IconAction>
        </ActionBarPrimitive.Root>
        <div className="flex min-w-0 max-w-[min(85%,calc(100%-4rem))] justify-end pointer-coarse:max-w-none pointer-coarse:basis-full">
          <div className="min-w-0 rounded-2xl border bg-surface-raised px-3.5 py-2 text-prose break-words whitespace-pre-wrap pointer-coarse:max-w-[85%]">
            <UserText key={id} />
          </div>
        </div>
        <div className="flex basis-full justify-end empty:hidden pointer-coarse:basis-auto">
          <BranchPicker />
        </div>
      </div>
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

export type Fold = "fits" | "folded" | "expanded";

/** A user message taller than this many lines folds to 12 lines (`max-h-[12lh]`) with Show more. */
export const FOLD_AFTER_LINES = 14;

/** The fold after measuring the text: taller than 14 lines (a pixel of rounding allowed) folds, and while it stays tall the reader's choice holds. */
export function measuredFold(fold: Fold, scrollHeight: number, lineHeight: number): Fold {
  const tall = Number.isFinite(lineHeight) && lineHeight > 0 && scrollHeight > lineHeight * FOLD_AFTER_LINES + 1;
  if (!tall) return "fits";
  return fold === "fits" ? "folded" : fold;
}

/** Show more and Show less. A message that fits has no toggle. */
export function toggledFold(fold: Fold): Fold {
  if (fold === "folded") return "expanded";
  if (fold === "expanded") return "folded";
  return fold;
}

// Copy and Edit read the message from the runtime, so they get every line while the text is folded.
function UserText() {
  const text = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const textId = useId();
  const [fold, setFold] = useState<Fold>("fits");
  // A layout effect, so a long message paints folded the first time. The observer measures again when the width or
  // the text size changes; scrollHeight counts the hidden lines while folded.
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => setFold((current) => measuredFold(current, element.scrollHeight, parseFloat(getComputedStyle(element).lineHeight)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const folded = fold === "folded";
  return (
    <>
      <div className="relative">
        <div ref={text} id={textId} data-folded={folded ? "true" : undefined} className={cn(folded && "max-h-[12lh] overflow-hidden")}>
          <MessagePrimitive.Parts components={userParts} />
        </div>
        {folded && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[1lh] bg-gradient-to-t from-surface-raised" />}
      </div>
      {fold !== "fits" && (
        <button
          ref={toggle}
          type="button"
          aria-expanded={fold === "expanded"}
          aria-controls={textId}
          onClick={() => {
            if (folded) return setFold(toggledFold(fold));
            // Folding a long message moves its end up; keep the toggle in view so the reader stays at this message.
            flushSync(() => setFold(toggledFold(fold)));
            toggle.current?.scrollIntoView({ block: "nearest" });
          }}
          className="mt-1 rounded-sm text-meta font-medium text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {folded ? "Show more" : "Show less"}
        </button>
      )}
    </>
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
          className="block max-h-60 max-w-full resize-none bg-transparent px-3.5 pt-2 text-field outline-none field-sizing-content scrollbar-thin"
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

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DotsThreeIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import type { listChats } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useCoarsePointer } from "@/components/use-coarse-pointer";

export type ChatSummary = ReturnType<typeof listChats>[number];

// The stored default title would repeat the New chat button label.
export function chatLabel(title: string) {
  return title === "New chat" ? "Untitled" : title;
}

// The input holds 120 characters, the PATCH limit.
const TITLE_MAX = 120;

type ChatAction = "rename" | "delete";

// The dropdown and the sheet list the same actions.
const CHAT_ACTIONS = [
  { action: "rename", label: "Rename", Icon: PencilSimpleIcon, className: "" },
  { action: "delete", label: "Delete", Icon: TrashIcon, className: "text-destructive focus:text-destructive" },
] as const satisfies readonly { action: ChatAction; label: string; Icon: typeof TrashIcon; className: string }[];

/** The title a rename sends, or null when the trimmed text is blank or unchanged, so nothing is sent. */
export function renameTitle(current: string, typed: string): string | null {
  const title = typed.trim();
  return title && title !== current ? title : null;
}

/** Focuses a chat's row link in whichever sidebar is on screen: the desktop column or the open drawer. */
export function focusChatRow(id: string) {
  for (const link of document.querySelectorAll<HTMLElement>("[data-chat-link]")) {
    if (link.dataset.chatLink !== id || link.offsetParent === null) continue;
    link.focus();
    return;
  }
}

function RowTrigger({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "mr-0.5 size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-surface-raised hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:grid data-[state=open]:text-foreground pointer-coarse:mr-0 pointer-coarse:grid pointer-coarse:size-11",
        className,
      )}
    >
      <DotsThreeIcon weight="bold" className="size-4" />
    </button>
  );
}

export function ChatRow({
  chat,
  active,
  onNavigate,
  onRename,
  onDelete,
}: {
  chat: ChatSummary;
  active: boolean;
  onNavigate?: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const coarse = useCoarsePointer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  // The action picked in the menu, read when the menu returns focus.
  const chosen = useRef<ChatAction | null>(null);
  // Enter, Escape and blur all end a rename; only the first one counts.
  const ended = useRef(false);
  const refocusLink = useRef(false);
  const label = chatLabel(chat.title);
  const href = `/c/${chat.id}`;

  // The menu traps focus while open, so the field takes it once the menu has closed.
  useEffect(() => {
    if (!renaming || menuOpen) return;
    input.current?.focus();
    input.current?.select();
  }, [renaming, menuOpen]);

  useEffect(() => {
    if (renaming || !refocusLink.current) return;
    refocusLink.current = false;
    link.current?.focus();
  }, [renaming]);

  function choose(action: ChatAction) {
    chosen.current = action;
    setMenuOpen(false);
    if (action === "rename") {
      ended.current = false;
      setRenaming(true);
    } else {
      onDelete();
    }
  }

  // Radix returns focus to the trigger. Rename keeps it in the field, and a deleted row has no trigger left.
  function closeAutoFocus(event: Event) {
    if (chosen.current === null) return;
    chosen.current = null;
    event.preventDefault();
  }

  function endRename(commit: boolean, refocus: boolean) {
    if (ended.current) return;
    ended.current = true;
    const title = commit ? renameTitle(chat.title, input.current?.value ?? "") : null;
    if (title !== null) onRename(title);
    refocusLink.current = refocus;
    setRenaming(false);
  }

  const trigger = <RowTrigger aria-label={`Actions for ${label}`} className={cn(active ? "grid" : "hidden group-hover/row:grid group-focus-within/row:grid")} />;

  return (
    <div
      data-chat-row={chat.id}
      className={cn(
        "group/row relative flex items-center rounded-md transition-colors",
        active
          ? "bg-accent text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sun"
          : cn("text-muted-foreground hover:bg-accent hover:text-foreground", menuOpen && "bg-accent text-foreground"),
      )}
    >
      {renaming ? (
        <input
          ref={input}
          aria-label="Chat title"
          data-chat-rename=""
          defaultValue={chat.title === "New chat" ? "" : chat.title}
          placeholder="Untitled"
          maxLength={TITLE_MAX}
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              endRename(true, true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              endRename(false, true);
            }
          }}
          onBlur={() => endRename(true, false)}
          className="mx-0.5 h-8 min-w-0 flex-1 rounded-md border bg-surface-sunken px-2 text-field text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11"
        />
      ) : (
        <Link
          ref={link}
          href={href}
          onClick={onNavigate}
          data-chat-link={chat.id}
          aria-current={active ? "page" : undefined}
          className="min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:py-3"
        >
          {label}
        </Link>
      )}
      {renaming ? null : coarse ? (
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent onCloseAutoFocus={closeAutoFocus}>
            <SheetTitle className="truncate px-5 pt-4 pb-1 text-muted-foreground">{label}</SheetTitle>
            <div role="menu" aria-label={label} className="flex flex-col p-2">
              {CHAT_ACTIONS.map(({ action, label: actionLabel, Icon, className }) => (
                <button
                  key={action}
                  type="button"
                  role="menuitem"
                  onClick={() => choose(action)}
                  className={cn(
                    "flex min-h-touch cursor-pointer items-center gap-3 rounded-md px-3 text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                    className,
                  )}
                >
                  <Icon weight="light" className="size-[18px] shrink-0" />
                  {actionLabel}
                </button>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={closeAutoFocus}>
            {CHAT_ACTIONS.map(({ action, label: actionLabel, Icon, className }) => (
              <DropdownMenuItem key={action} onSelect={() => choose(action)} className={className}>
                <Icon weight="light" className="size-4" />
                {actionLabel}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

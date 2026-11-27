"use client";

import { useReducer, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BrainIcon, GearSixIcon, MagnifyingGlassIcon, NotePencilIcon, ShieldCheckIcon, SidebarSimpleIcon, SignOutIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";
import { idleSubmit, submitTransition } from "@/lib/submit-state";
import type { Role } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OrbitMark } from "@/components/orbit-mark";
import { groupChatsByRecency } from "@/components/shell/chat-groups";
import { serverTodaySnapshot, subscribeToday, todaySnapshot } from "@/components/shell/today";
import { ShortcutKbd } from "@/components/shell/shortcuts";
import { ChatRow, focusChatRow, type ChatSummary } from "./chat-row-menu";

// Null on the server: its timezone is not the reader's, so buckets are computed only in the browser.
function useToday() {
  return useSyncExternalStore(subscribeToday, todaySnapshot, serverTodaySnapshot);
}

const footerLinkClass =
  "flex h-8 items-center gap-2 rounded-md px-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11";

export function Sidebar({
  chats,
  email,
  role,
  onNewChat,
  onSearch,
  onRename,
  onDelete,
  beforeSignOut,
  onCollapse,
  onNavigate,
}: {
  chats: ChatSummary[];
  email: string;
  role: Role;
  onNewChat: () => void;
  onSearch: () => void;
  onRename: (chat: ChatSummary, title: string) => void;
  onDelete: (chat: ChatSummary) => void;
  /** Runs before Sign out ends the session. */
  beforeSignOut: () => Promise<boolean>;
  onCollapse?: () => void;
  /** Called when a link is followed, including the current page's, which changes no route. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const today = useToday();
  const groups = today === null ? [{ label: null, chats }] : groupChatsByRecency(chats, today);

  function remove(chat: ChatSummary, active: boolean) {
    const order = groups.flatMap((group) => group.chats);
    const index = order.findIndex((item) => item.id === chat.id);
    const neighbor = order[index + 1] ?? order[index - 1];
    onDelete(chat);
    // Deleting the open chat opens a draft, whose composer takes focus. Otherwise the row's place does.
    if (!active && neighbor) window.setTimeout(() => focusChatRow(neighbor.id), 0);
  }

  return (
    <div className="flex h-full w-64 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-3 pointer-coarse:h-14">
        <Link href="/" onClick={onNavigate} className="mr-auto flex items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <OrbitMark className="size-5" />
          <span className="text-sm font-medium tracking-tight">orbit</span>
        </Link>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Close sidebar" className="text-muted-foreground hover:text-foreground">
                <SidebarSimpleIcon weight="light" className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-2">
              Close sidebar <ShortcutKbd name="sidebar" />
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onNewChat} aria-label="New chat" className="text-muted-foreground hover:text-foreground">
              <NotePencilIcon weight="light" className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-2">
            New chat <ShortcutKbd name="newChat" />
          </TooltipContent>
        </Tooltip>
      </div>

      <button
        type="button"
        onClick={onSearch}
        className="mx-2 flex h-8 pointer-coarse:h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md border bg-surface-sunken pr-1.5 pl-2.5 text-sm text-muted-foreground transition-colors outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <MagnifyingGlassIcon weight="regular" className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <ShortcutKbd name="palette" />
      </button>

      <nav className="scrollbar-thin mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
        {groups.map((group) => (
          <div key={group.label ?? "all"} className="flex flex-col gap-px">
            {group.label && <h2 className="px-2.5 pb-1 text-meta font-medium text-muted-foreground">{group.label}</h2>}
            {group.chats.map((chat) => {
              const active = pathname === `/c/${chat.id}`;
              return (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={active}
                  onNavigate={onNavigate}
                  onRename={(title) => onRename(chat, title)}
                  onDelete={() => remove(chat, active)}
                />
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex shrink-0 flex-col gap-px border-t p-2">
        {(
          [
            { href: "/memory", label: "Memory", Icon: BrainIcon },
            { href: "/settings", label: "Settings", Icon: GearSixIcon },
            ...(role === "admin" ? [{ href: "/admin", label: "Admin", Icon: ShieldCheckIcon }] : []),
          ] as const
        ).map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={pathname === href ? "page" : undefined}
            className={cn(footerLinkClass, pathname === href ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
          >
            <Icon weight="light" className="size-[18px] shrink-0" />
            {label}
          </Link>
        ))}
        <div className="mt-1 flex items-center gap-2 pl-1.5">
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border bg-surface-raised text-meta font-medium text-foreground uppercase">
            {email.charAt(0)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{email}</span>
          <SignOut beforeSignOut={beforeSignOut} />
        </div>
      </div>
    </div>
  );
}

function SignOut({ beforeSignOut }: { beforeSignOut: () => Promise<boolean> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  // Closing the dialog hands focus back to Sign out. A tooltip opened by that focus would cover the drawer and take
  // the next Escape, so it stays shut until the button is left or pointed at again.
  const quietTip = useRef(false);
  const [state, dispatch] = useReducer(submitTransition, idleSubmit);
  // Stays locked after success too, while the page leaves for /login.
  const busy = state.status === "pending" || state.status === "succeeded";

  async function signOut() {
    if (busy) return;
    dispatch({ type: "submit" });
    if (!(await beforeSignOut())) {
      dispatch({ type: "fail", error: "Could not delete chat" });
      return;
    }
    // A network failure rejects, and an HTTP error resolves with `error`.
    const result = await authClient.signOut().catch(() => null);
    if (!result || result.error) {
      dispatch({ type: "fail", error: "Could not sign out" });
      return;
    }
    dispatch({ type: "succeed" });
    router.push("/login");
    router.refresh();
  }

  function setDialog(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) dispatch({ type: "edit" });
  }

  return (
    <Dialog open={open} onOpenChange={setDialog}>
      <Tooltip
        open={tip}
        onOpenChange={(next) => {
          if (next && quietTip.current) return;
          setTip(next);
        }}
      >
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sign out"
              onBlur={() => {
                quietTip.current = false;
              }}
              onPointerEnter={() => {
                quietTip.current = false;
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <SignOutIcon weight="light" className="size-[18px]" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Sign out</TooltipContent>
      </Tooltip>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onCloseAutoFocus={() => {
          quietTip.current = true;
        }}
        className="sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>Sign out?</DialogTitle>
        </DialogHeader>
        {state.status === "failed" ? (
          <p role="alert" className="flex items-center gap-2 text-meta text-destructive">
            <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
            {state.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDialog(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={signOut} disabled={busy}>
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

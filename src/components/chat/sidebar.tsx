"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MagnifyingGlassIcon, NotePencilIcon, SidebarSimpleIcon, SignOutIcon } from "@phosphor-icons/react";
import type { listChats } from "@/lib/messages";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OrbitMark } from "@/components/orbit-mark";
import { groupChatsByRecency } from "@/components/shell/chat-groups";
import { serverTodaySnapshot, subscribeToday, todaySnapshot } from "@/components/shell/today";
import { ShortcutKbd } from "@/components/shell/shortcuts";

export type ChatSummary = ReturnType<typeof listChats>[number];

// The stored default title would repeat the New chat button label.
export function chatLabel(title: string) {
  return title === "New chat" ? "Untitled" : title;
}

// Null on the server: its timezone is not the reader's, so buckets are computed only in the browser.
function useToday() {
  return useSyncExternalStore(subscribeToday, todaySnapshot, serverTodaySnapshot);
}

export function Sidebar({
  chats,
  email,
  onNewChat,
  onSearch,
  onCollapse,
  onNavigate,
}: {
  chats: ChatSummary[];
  email: string;
  onNewChat: () => void;
  onSearch: () => void;
  onCollapse?: () => void;
  /** Called when a link is followed, including the current page's, which changes no route. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const today = useToday();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const groups = today === null ? [{ label: null, chats }] : groupChatsByRecency(chats, today);

  async function signOut() {
    setSignOutFailed(false);
    // A network failure rejects, and an HTTP error resolves with `error`.
    const result = await authClient.signOut().catch(() => null);
    if (!result || result.error) {
      setSignOutFailed(true);
      return;
    }
    router.push("/login");
    router.refresh();
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
              const href = `/c/${chat.id}`;
              const active = pathname === href;
              return (
                <Link
                  key={chat.id}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative truncate rounded-md px-2.5 py-1.5 text-sm pointer-coarse:py-3 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    active
                      ? "bg-accent text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sun"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {chatLabel(chat.title)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t p-2">
        {signOutFailed && (
          <p role="alert" className="px-1.5 pb-1.5 text-meta text-destructive">
            Could not sign out
          </p>
        )}
        <div className="flex items-center gap-1">
          <Link
            href="/settings"
            onClick={onNavigate}
            aria-current={pathname === "/settings" ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              pathname === "/settings" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <span className="sr-only">Settings</span>
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border bg-surface-raised text-meta font-medium text-foreground uppercase">
              {email.charAt(0)}
            </span>
            <span className="truncate">{email}</span>
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={signOut} aria-label="Sign out" className="text-muted-foreground hover:text-foreground">
                <SignOutIcon weight="light" className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Sign out</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

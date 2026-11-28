"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { NotePencilIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { requestJson } from "@/lib/request-json";
import { LIMITS } from "@/lib/route-schema";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatLabel, focusChatRow, type ChatSummary } from "@/components/chat/chat-row-menu";
import { Sidebar } from "@/components/chat/sidebar";
import type { Role } from "@/lib/session";
import { DESKTOP_QUERY } from "@/components/use-desktop";
import { chatDeleteReducer, hiddenChatIds, initialChatDelete, undoReopensChat, type ChatDeleteEvent } from "./chat-delete";
import { CommandPalette } from "./command-palette";
import { HeaderSlotContext } from "./header-slot";
import { ShortcutKbd, useShortcuts } from "./shortcuts";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";
import { Notices, TimedAlert, UndoToast, useUndoCountdown } from "./undo-toast";

const renamedChat = z.object({ id: z.string(), title: z.string() });
// DELETE answers 204 with no body.
const deletedChat = z.undefined();

// A rename shows at once. `base` is the server's title when it was sent: once the server's list shows another
// title, the edit has landed or someone else renamed the chat, and the list wins. `previous` is the saved rename
// a failure falls back to while the list has not caught up with it yet.
type SavedTitle = { title: string; base: string; seq: number; saved: true };
type TitleEdit = SavedTitle | { title: string; base: string; seq: number; saved: false; previous: SavedTitle | null };

function chatApi(id: string) {
  return `/api/chats/${encodeURIComponent(id)}`;
}

// The reply checkpoint ReplyLink keeps for this chat (`orbit-stream:<id>` in reply-link.tsx).
function forgetReplyCheckpoint(id: string) {
  try {
    window.sessionStorage.removeItem(`orbit-stream:${id}`);
  } catch {
    // Nothing was stored when the browser blocks storage.
  }
}

// Chats whose DELETE left as the page went away. A reload renders its sidebar before that DELETE lands, so the
// next page in this tab hides them and sends the DELETE again, which answers 404 once the first one has landed.
const LEAVING_DELETES = "orbit-leaving-deletes";
const leavingDeletes = z.array(z.string().max(LIMITS.id)).max(100).catch([]);

function readLeavingDeletes(): string[] {
  try {
    return leavingDeletes.parse(JSON.parse(window.sessionStorage.getItem(LEAVING_DELETES) ?? "[]"));
  } catch {
    // Blocked storage or a broken entry holds nothing to send.
    return [];
  }
}

function writeLeavingDeletes(ids: string[]) {
  try {
    if (ids.length === 0) window.sessionStorage.removeItem(LEAVING_DELETES);
    else window.sessionStorage.setItem(LEAVING_DELETES, JSON.stringify(ids));
  } catch {
    // With storage blocked, the next page lists the chat until its list refreshes.
  }
}

function withTitle(chat: ChatSummary, edit: TitleEdit | undefined): ChatSummary {
  return edit && edit.base === chat.title ? { ...chat, title: edit.title } : chat;
}

const PAGE_TITLES: Readonly<Record<string, string | undefined>> = { "/settings": "Settings", "/memory": "Memory", "/tools": "Tools" };

export function AppShell({
  chats,
  email,
  role,
  initialCollapsed,
  children,
}: {
  chats: ChatSummary[];
  email: string;
  role: Role;
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // `animate` turns on at the first toggle, so the server-rendered state never slides on load.
  const [sidebar, setSidebar] = useState({ collapsed: initialCollapsed, animate: false });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteReturnFocus = useRef<HTMLElement | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const [titleEdits, setTitleEdits] = useState<ReadonlyMap<string, TitleEdit>>(() => new Map());
  const latestRename = useRef(new Map<string, number>());
  const renameSeq = useRef(0);
  // Keys the "Could not rename" alert, so a second failure restarts its time. 0 shows none.
  const [renameFailure, setRenameFailure] = useState(0);

  const [deletes, setDeletes] = useState(initialChatDelete);
  // Browser departure can happen in the same event as a delete or Undo, before React renders again.
  const liveDeletes = useRef(initialChatDelete);
  const dispatchDelete = useCallback((event: ChatDeleteEvent) => {
    const next = chatDeleteReducer(liveDeletes.current, event);
    liveDeletes.current = next;
    setDeletes(next);
  }, []);
  // Deleted on the server, but still in `chats` until the refresh lands.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const sentDeletes = useRef(new Map<string, Promise<boolean>>());
  const refreshAfterDeletes = useRef(false);

  const hidden = hiddenChatIds(deletes);
  const removedIds: ReadonlySet<string> = new Set([...hidden, ...deletedIds]);
  const visibleChats = chats.flatMap((chat) => (removedIds.has(chat.id) ? [] : [withTitle(chat, titleEdits.get(chat.id))]));

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // CSS hides the drawer on desktop, but an open modal would still block every click.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const close = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, []);

  // The palette opens from a shortcut, so Dialog has no trigger to restore focus to.
  function setPalette(next: boolean) {
    if (next) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) paletteReturnFocus.current = active;
    }
    setPaletteOpen(next);
  }

  useEffect(() => {
    if (paletteOpen) return;
    const target = paletteReturnFocus.current;
    paletteReturnFocus.current = null;
    if (!target?.isConnected) return;
    // Radix restores focus to the body on close; run after it.
    const timer = setTimeout(() => target.focus(), 0);
    return () => clearTimeout(timer);
  }, [paletteOpen]);

  function setCollapsed(collapsed: boolean) {
    document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
    setSidebar({ collapsed, animate: true });
  }

  function openSidebar() {
    if (window.matchMedia(DESKTOP_QUERY).matches) setCollapsed(false);
    else setDrawerOpen(true);
  }

  function toggleSidebar() {
    if (window.matchMedia(DESKTOP_QUERY).matches) setCollapsed(!sidebar.collapsed);
    else setDrawerOpen((open) => !open);
  }

  // A draft gets its chats row only when its first message commits, so New chat writes nothing.
  function newChat() {
    setDrawerOpen(false);
    router.push("/new");
  }

  useShortcuts({
    palette: () => setPalette(!paletteOpen),
    newChat,
    sidebar: toggleSidebar,
  });

  // Edits whose request finished leave once the server's list has caught up. A deleted chat's edit leaves too.
  useEffect(() => {
    setTitleEdits((edits) => {
      let next: Map<string, TitleEdit> | null = null;
      for (const [id, edit] of edits) {
        const server = chats.find((chat) => chat.id === id)?.title;
        if (server !== undefined && (!edit.saved || (server !== edit.title && server === edit.base))) continue;
        next ??= new Map(edits);
        next.delete(id);
      }
      return next ?? edits;
    });
    // A draft can reuse a deleted chat's id after Back, so an id the list no longer holds is forgotten.
    setDeletedIds((ids) => {
      const listed = new Set(chats.map((chat) => chat.id));
      const kept = [...ids].filter((id) => listed.has(id));
      return kept.length === ids.size ? ids : new Set(kept);
    });
  }, [chats]);

  function renameChat(chat: ChatSummary, title: string) {
    const base = chats.find((item) => item.id === chat.id)?.title ?? chat.title;
    const seq = ++renameSeq.current;
    latestRename.current.set(chat.id, seq);
    setTitleEdits((edits) => {
      const previous = edits.get(chat.id);
      return new Map(edits).set(chat.id, { title, base, seq, saved: false, previous: previous?.saved ? previous : null });
    });
    setRenameFailure(0);
    void requestJson(chatApi(chat.id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }, {
      parse: renamedChat,
      onOk: (saved) => {
        if (latestRename.current.get(chat.id) !== seq) return;
        latestRename.current.delete(chat.id);
        setTitleEdits((edits) => {
          const edit = edits.get(chat.id);
          return edit?.seq === seq ? new Map(edits).set(chat.id, { title: saved.title, base: edit.base, seq, saved: true }) : edits;
        });
        router.refresh();
      },
      onFailed: () => {
        if (latestRename.current.get(chat.id) !== seq) return;
        latestRename.current.delete(chat.id);
        setTitleEdits((edits) => {
          const edit = edits.get(chat.id);
          if (edit?.seq !== seq || edit.saved) return edits;
          const next = new Map(edits);
          if (edit.previous) next.set(chat.id, edit.previous);
          else next.delete(chat.id);
          return next;
        });
        setRenameFailure(seq);
        // An earlier rename may have landed, so the list reloads instead of trusting the old title.
        router.refresh();
      },
    });
  }

  const commitDeletes = useCallback(() => liveDeletes.current.committing.map(({ id }) => {
    const existing = sentDeletes.current.get(id);
    if (existing) return existing;

    let resolve!: (removed: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    sentDeletes.current.set(id, promise);
    function settle(removed: boolean) {
      writeLeavingDeletes(readLeavingDeletes().filter((leaving) => leaving !== id));
      if (removed) {
        forgetReplyCheckpoint(id);
        setDeletedIds((ids) => new Set(ids).add(id));
        refreshAfterDeletes.current = true;
      }
      dispatchDelete({ type: removed ? "committed" : "failed", id });
      sentDeletes.current.delete(id);
      resolve(removed);
    }
    // Keepalive lets the DELETE outlive a reload or closed tab.
    void requestJson(chatApi(id), { method: "DELETE", keepalive: true }, {
      parse: deletedChat,
      onOk: () => settle(true),
      onFailed: (failure) => settle(failure.kind === "http" && failure.status === 404),
    });
    return promise;
  }), [dispatchDelete]);

  const setUndoPaused = useUndoCountdown(deletes.pending, (subject) => {
    if (liveDeletes.current.pending !== subject) return;
    dispatchDelete({ type: "expire" });
    commitDeletes();
  });

  useEffect(() => {
    if (deletes.committing.length > 0 || !refreshAfterDeletes.current) return;
    refreshAfterDeletes.current = false;
    router.refresh();
  }, [deletes.committing, router]);

  // A reload or a closed tab ends the undo window. Effects may not run before the page goes, so the DELETE
  // leaves from inside the event.
  useEffect(() => {
    function commitPending() {
      dispatchDelete({ type: "expire" });
      const leaving = liveDeletes.current.committing.map((chat) => chat.id);
      if (leaving.length === 0) return;
      writeLeavingDeletes([...new Set([...readLeavingDeletes(), ...leaving])]);
      commitDeletes();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") commitPending();
    }
    window.addEventListener("pagehide", commitPending);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", commitPending);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [commitDeletes, dispatchDelete]);

  // Sign out ends the session and leaves without a pagehide, and a DELETE that reaches the server after it answers
  // 401. A delete still waiting for Undo is sent now, and Sign out waits until every DELETE in flight has an answer.
  async function settleDeletes() {
    dispatchDelete({ type: "expire" });
    return (await Promise.all(commitDeletes())).every(Boolean);
  }

  // The list this page rendered with can still hold chats the last page deleted as it went away.
  const firstChats = useRef(chats);
  useEffect(() => {
    const leaving = new Set(readLeavingDeletes());
    if (leaving.size === 0) return;
    const listed = firstChats.current.filter((chat) => leaving.has(chat.id));
    // A chat the list no longer holds is already gone.
    writeLeavingDeletes(listed.map((chat) => chat.id));
    dispatchDelete({ type: "commit", chats: listed });
    commitDeletes();
  }, [commitDeletes, dispatchDelete]);

  // A server reply keeps running when the chat closes, so Undo can reopen it mid-stream.
  function deleteChat(chat: ChatSummary) {
    if (removedIds.has(chat.id) || hiddenChatIds(liveDeletes.current).has(chat.id)) return;
    const wasOpen = pathname === `/c/${chat.id}`;
    dispatchDelete({ type: "delete", chat, wasOpen });
    commitDeletes();
    if (wasOpen) {
      setDrawerOpen(false);
      router.push("/new");
    }
  }

  function undoDelete() {
    const pending = liveDeletes.current.pending;
    if (!pending) return;
    dispatchDelete({ type: "undo" });
    if (undoReopensChat(pending, window.location.href)) router.push(`/c/${pending.chat.id}`);
    else window.setTimeout(() => focusChatRow(pending.chat.id), 0);
  }

  // Every sidebar chat has two Tab stops, so the first one on the page skips past them to the composer or the page.
  function skipToContent(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const content = document.getElementById("content");
    const composer = pathname.startsWith("/c/")
      ? content?.querySelector<HTMLTextAreaElement>("textarea[data-chat-composer]:not([disabled])")
      : null;
    (composer ?? content)?.focus();
  }

  const current = visibleChats.find((chat) => pathname === `/c/${chat.id}`);
  const title = pathname === "/admin" && role === "admin" ? "Admin" : PAGE_TITLES[pathname] ?? (current && chatLabel(current.title));

  // An open drawer hides the rest of the page from screen readers and clicks, so the notices go inside it then.
  const notices =
    deletes.pending || deletes.failed || renameFailure ? (
      <Notices>
        {deletes.pending ? <UndoToast key={deletes.pending.chat.id} onUndo={undoDelete} onPausedChange={setUndoPaused} /> : null}
        {deletes.failed ? (
          <TimedAlert key={`delete:${deletes.failed.id}`} onDone={() => dispatchDelete({ type: "dismiss" })}>
            Could not delete
          </TimedAlert>
        ) : null}
        {renameFailure ? (
          <TimedAlert key={`rename:${renameFailure}`} onDone={() => setRenameFailure(0)}>
            Could not rename
          </TimedAlert>
        ) : null}
      </Notices>
    ) : null;

  const sidebarProps = {
    chats: visibleChats,
    email,
    role,
    onNewChat: newChat,
    onSearch: () => setPalette(true),
    onRename: renameChat,
    onDelete: deleteChat,
    beforeSignOut: settleDeletes,
  };

  return (
    <HeaderSlotContext.Provider value={headerSlot}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <a
          href="#content"
          onClick={skipToContent}
          className="sr-only focus:not-sr-only focus:fixed focus:left-[max(0.5rem,env(safe-area-inset-left))] focus:top-[max(0.5rem,env(safe-area-inset-top))] focus:z-[70] focus:rounded-lg focus:border focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-float focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {pathname.startsWith("/c/") ? "Skip to chat" : "Skip to content"}
        </a>
        <aside
          inert={sidebar.collapsed}
          className={cn(
            "hidden shrink-0 overflow-hidden md:block",
            sidebar.animate && "transition-[width] duration-200 ease-orbit",
            sidebar.collapsed ? "w-0" : "w-64 border-r",
          )}
        >
          <Sidebar {...sidebarProps} onCollapse={() => setCollapsed(true)} />
        </aside>

        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPortal>
            <DialogOverlay className="md:hidden" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                // Focusing the first button would pop its tooltip over the drawer.
                event.preventDefault();
                (event.currentTarget as HTMLElement).focus();
              }}
              onEscapeKeyDown={(event) => {
                // Escape in a rename field cancels the rename and keeps the drawer open.
                if (event.target instanceof HTMLElement && event.target.closest("[data-chat-rename]")) event.preventDefault();
              }}
              className="fixed inset-y-0 left-0 z-50 border-r bg-background shadow-float outline-none duration-200 ease-orbit data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden"
            >
              <DialogTitle className="sr-only">Chats</DialogTitle>
              <Sidebar {...sidebarProps} onNavigate={() => setDrawerOpen(false)} />
              {drawerOpen ? notices : null}
            </DialogPrimitive.Content>
          </DialogPortal>
        </Dialog>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className={cn("flex h-11 shrink-0 items-center gap-1.5 border-b px-2", !sidebar.collapsed && "md:hidden")}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={openSidebar} aria-label="Open sidebar" className="text-muted-foreground hover:text-foreground">
                  <SidebarSimpleIcon weight="light" className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex items-center gap-2">
                Open sidebar <ShortcutKbd name="sidebar" />
              </TooltipContent>
            </Tooltip>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
            {/* Page actions, such as the thread's Prompts button on phones, render here. */}
            <div ref={setHeaderSlot} className="contents" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={newChat} aria-label="New chat" className="text-muted-foreground hover:text-foreground">
                  <NotePencilIcon weight="light" className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex items-center gap-2">
                New chat <ShortcutKbd name="newChat" />
              </TooltipContent>
            </Tooltip>
          </header>
          <main id="content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
            {children}
          </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPalette}
          chats={visibleChats}
          role={role}
          hiddenChatIds={removedIds}
          onNewChat={newChat}
          onAction={() => setDrawerOpen(false)}
        />

        {drawerOpen ? null : notices}
      </div>
    </HeaderSlotContext.Provider>
  );
}

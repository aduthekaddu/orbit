"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { NotePencilIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatLabel, focusChatRow, type ChatSummary } from "@/components/chat/chat-row-menu";
import { Sidebar } from "@/components/chat/sidebar";
import { DESKTOP_QUERY } from "@/components/use-desktop";
import { chatDeleteReducer, hiddenChatIds, initialChatDelete } from "./chat-delete";
import { CommandPalette } from "./command-palette";
import { HeaderSlotContext } from "./header-slot";
import { ShortcutKbd, useShortcuts } from "./shortcuts";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";
import { Notices, TimedAlert, UndoToast, useUndoCountdown } from "./undo-toast";

const renamedChat = z.object({ id: z.string(), title: z.string() });
// DELETE answers 204 with no body.
const deletedChat = z.undefined();

// A rename shows at once. `base` is the server's title when it was sent: once the server's list shows another
// title, the edit has landed or someone else renamed the chat, and the list wins.
type TitleEdit = { title: string; base: string; seq: number; saved: boolean };

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

function withTitle(chat: ChatSummary, edit: TitleEdit | undefined): ChatSummary {
  return edit && edit.base === chat.title ? { ...chat, title: edit.title } : chat;
}

export function AppShell({
  chats,
  email,
  initialCollapsed,
  children,
}: {
  chats: ChatSummary[];
  email: string;
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

  const [deletes, dispatchDelete] = useReducer(chatDeleteReducer, initialChatDelete);
  // Deleted on the server, but still in `chats` until the refresh lands.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const sentDeletes = useRef(new Set<string>());
  const refreshAfterDeletes = useRef(false);
  const pendingDelete = useRef(deletes.pending);
  useEffect(() => {
    pendingDelete.current = deletes.pending;
  });
  const setUndoPaused = useUndoCountdown(deletes.pending, () => dispatchDelete({ type: "expire" }));

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
    setTitleEdits((edits) => new Map(edits).set(chat.id, { title, base, seq, saved: false }));
    setRenameFailure(0);
    void requestJson(chatApi(chat.id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }, {
      parse: renamedChat,
      onOk: (saved) => {
        if (latestRename.current.get(chat.id) !== seq) return;
        latestRename.current.delete(chat.id);
        setTitleEdits((edits) => {
          const edit = edits.get(chat.id);
          return edit?.seq === seq ? new Map(edits).set(chat.id, { ...edit, title: saved.title, saved: true }) : edits;
        });
        router.refresh();
      },
      onFailed: () => {
        if (latestRename.current.get(chat.id) !== seq) return;
        latestRename.current.delete(chat.id);
        setTitleEdits((edits) => {
          if (edits.get(chat.id)?.seq !== seq) return edits;
          const next = new Map(edits);
          next.delete(chat.id);
          return next;
        });
        setRenameFailure(seq);
        // An earlier rename may have landed, so the list reloads instead of trusting the old title.
        router.refresh();
      },
    });
  }

  const commitDelete = useCallback((id: string) => {
    // StrictMode, pagehide and the committing effect can all reach one id.
    if (sentDeletes.current.has(id)) return;
    sentDeletes.current.add(id);
    function committed() {
      forgetReplyCheckpoint(id);
      setDeletedIds((ids) => new Set(ids).add(id));
      refreshAfterDeletes.current = true;
      dispatchDelete({ type: "committed", id });
    }
    // keepalive lets the DELETE outlive a reload or a closed tab.
    void requestJson(chatApi(id), { method: "DELETE", keepalive: true }, {
      parse: deletedChat,
      onOk: committed,
      onFailed: (failure) => {
        if (failure.kind === "http" && failure.status === 404) {
          committed();
          return;
        }
        sentDeletes.current.delete(id);
        dispatchDelete({ type: "failed", id });
      },
    });
  }, []);

  useEffect(() => {
    for (const chat of deletes.committing) commitDelete(chat.id);
  }, [deletes.committing, commitDelete]);

  useEffect(() => {
    if (deletes.committing.length > 0 || !refreshAfterDeletes.current) return;
    refreshAfterDeletes.current = false;
    router.refresh();
  }, [deletes.committing, router]);

  // A reload or a closed tab ends the undo window. Effects may not run before the page goes, so the DELETE
  // leaves from inside the event.
  useEffect(() => {
    function commitPending() {
      const pending = pendingDelete.current;
      if (!pending) return;
      commitDelete(pending.chat.id);
      dispatchDelete({ type: "expire" });
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
  }, [commitDelete]);

  // A server reply keeps running when the chat closes, so Undo can reopen it mid-stream.
  function deleteChat(chat: ChatSummary) {
    if (removedIds.has(chat.id)) return;
    const wasOpen = pathname === `/c/${chat.id}`;
    dispatchDelete({ type: "delete", chat, wasOpen });
    if (wasOpen) {
      setDrawerOpen(false);
      router.push("/new");
    }
  }

  const onDraft = pathname === "/new" || (pathname.startsWith("/c/") && !chats.some((chat) => pathname === `/c/${chat.id}`));

  function undoDelete() {
    const pending = deletes.pending;
    if (!pending) return;
    dispatchDelete({ type: "undo" });
    // Back to the chat from the draft its delete opened. A page picked since then stays open.
    if (pending.wasOpen && onDraft) router.push(`/c/${pending.chat.id}`);
    else window.setTimeout(() => focusChatRow(pending.chat.id), 0);
  }

  const current = visibleChats.find((chat) => pathname === `/c/${chat.id}`);
  const title = pathname === "/settings" ? "Settings" : pathname === "/memory" ? "Memory" : current && chatLabel(current.title);

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
    onNewChat: newChat,
    onSearch: () => setPalette(true),
    onRename: renameChat,
    onDelete: deleteChat,
  };

  return (
    <HeaderSlotContext.Provider value={headerSlot}>
      <div className="flex h-dvh overflow-hidden bg-background">
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
          {children}
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPalette}
          chats={visibleChats}
          hiddenChatIds={removedIds}
          onNewChat={newChat}
          onAction={() => setDrawerOpen(false)}
        />

        {drawerOpen ? null : notices}
      </div>
    </HeaderSlotContext.Provider>
  );
}

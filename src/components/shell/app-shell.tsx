"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { NotePencilIcon, SidebarSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sidebar, chatLabel, type ChatSummary } from "@/components/chat/sidebar";
import { DESKTOP_QUERY } from "@/components/use-desktop";
import { CommandPalette } from "./command-palette";
import { ShortcutKbd, useShortcuts } from "./shortcuts";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";

const NEW_CHAT_ERROR_MS = 4000;
const createdChat = z.object({ id: z.string().min(1) });

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
  const [newChatState, setNewChatState] = useState<"idle" | "pending" | "failed">("idle");
  const newChatPending = newChatState === "pending";
  const latestNewChat = useLatestRequest();

  useEffect(() => {
    setDrawerOpen(false);
    setNewChatState((state) => (state === "failed" ? "idle" : state));
  }, [pathname]);

  useEffect(() => {
    if (newChatState !== "failed") return;
    const timer = setTimeout(() => setNewChatState("idle"), NEW_CHAT_ERROR_MS);
    return () => clearTimeout(timer);
  }, [newChatState]);

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

  useEffect(() => {
    return () => {
      latestNewChat();
      setNewChatState((state) => (state === "pending" ? "idle" : state));
    };
  }, [pathname, latestNewChat]);

  async function newChat() {
    if (newChatState === "pending") return;
    setNewChatState("pending");
    const signal = latestNewChat();
    await requestJson("/api/chats", { method: "POST", signal }, {
      parse: createdChat,
      onOk: ({ id }) => {
        setNewChatState("idle");
        router.push(`/c/${id}`);
        router.refresh();
      },
      onFailed: () => setNewChatState("failed"),
    });
  }

  useShortcuts({
    palette: () => setPalette(!paletteOpen),
    newChat,
    sidebar: toggleSidebar,
  });

  const current = chats.find((chat) => pathname === `/c/${chat.id}`);
  const title = pathname === "/settings" ? "Settings" : pathname === "/memory" ? "Memory" : current && chatLabel(current.title);

  // An open drawer hides the rest of the page from screen readers, so the alert goes inside it then.
  const newChatError =
    newChatState === "failed" ? (
      <p
        role="alert"
        className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-meta text-destructive shadow-float animate-rise"
      >
        <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
        Could not create chat
      </p>
    ) : null;

  const sidebarProps = {
    chats,
    email,
    newChatPending,
    onNewChat: newChat,
    onSearch: () => setPalette(true),
  };

  return (
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
            className="fixed inset-y-0 left-0 z-50 border-r bg-background shadow-float outline-none duration-200 ease-orbit data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden"
          >
            <DialogTitle className="sr-only">Chats</DialogTitle>
            <Sidebar {...sidebarProps} onNavigate={() => setDrawerOpen(false)} />
            {drawerOpen ? newChatError : null}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={newChat} disabled={newChatPending} aria-label="New chat" className="text-muted-foreground hover:text-foreground">
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
        chats={chats}
        onNewChat={newChat}
        onAction={() => setDrawerOpen(false)}
      />

      {drawerOpen ? null : newChatError}
    </div>
  );
}

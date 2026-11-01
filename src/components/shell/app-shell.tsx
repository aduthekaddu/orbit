"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { NotePencilIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sidebar, type ChatSummary } from "@/components/chat/sidebar";
import { CommandPalette } from "./command-palette";
import { ShortcutKbd, useShortcuts } from "./shortcuts";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";

const DESKTOP_QUERY = "(min-width: 48rem)";

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
  const [newChatPending, setNewChatPending] = useState(false);

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

  async function newChat() {
    if (newChatPending) return;
    setNewChatPending(true);
    try {
      const response = await fetch("/api/chats", { method: "POST" });
      if (!response.ok) return;
      const body = (await response.json()) as { id: string };
      router.push(`/c/${body.id}`);
      router.refresh();
    } finally {
      setNewChatPending(false);
    }
  }

  useShortcuts({
    palette: () => setPalette(!paletteOpen),
    newChat,
    sidebar: () => setCollapsed(!sidebar.collapsed),
  });

  const title = pathname === "/settings" ? "Settings" : chats.find((chat) => pathname === `/c/${chat.id}`)?.title;

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

      <CommandPalette open={paletteOpen} onOpenChange={setPalette} chats={chats} onNewChat={newChat} />
    </div>
  );
}

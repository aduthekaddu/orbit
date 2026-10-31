"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OrbitMark } from "@/components/orbit-mark";
import { Sidebar, type ChatSummary } from "@/components/chat/sidebar";
import { CommandPalette } from "./command-palette";
import { ShortcutKbd, useShortcuts } from "./shortcuts";

const COLLAPSED_KEY = "orbit:sidebar-collapsed";
const DESKTOP_QUERY = "(min-width: 48rem)";

export function AppShell({ chats, email, children }: { chats: ChatSummary[]; email: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // `animate` stays false for the value restored from storage so a collapsed sidebar does not slide shut on load.
  const [sidebar, setSidebar] = useState({ collapsed: false, animate: false });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteReturnFocus = useRef<HTMLElement | null>(null);
  const [newChatPending, setNewChatPending] = useState(false);

  useEffect(() => {
    setSidebar({ collapsed: localStorage.getItem(COLLAPSED_KEY) === "1", animate: false });
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

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
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
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
            <Sidebar {...sidebarProps} />
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
          <OrbitMark className="size-5" />
        </header>
        {children}
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPalette} chats={chats} onNewChat={newChat} />
    </div>
  );
}

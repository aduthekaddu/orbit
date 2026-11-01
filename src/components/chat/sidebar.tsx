"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOutIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Sidebar({
  chats,
  email,
}: {
  chats: { id: string; title: string }[];
  email: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function newChat() {
    setPending(true);
    try {
      const response = await fetch("/api/chats", { method: "POST" });
      if (!response.ok) return;
      const body = (await response.json()) as { id: string };
      router.push(`/c/${body.id}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center justify-between px-3 py-3">
        <Link href="/" className="px-2 text-sm font-semibold">
          Orbit
        </Link>
        <Button variant="ghost" size="icon" onClick={newChat} disabled={pending} aria-label="New chat">
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {chats.map((chat) => {
          const href = `/c/${chat.id}`;
          const active = pathname === href;
          return (
            <Link
              key={chat.id}
              href={href}
              className={cn(
                "truncate rounded-md px-2 py-1.5 text-sm",
                active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
            >
              {chat.title}
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center gap-1 border-t p-2">
        <Link
          href="/settings"
          className={cn(
            "flex flex-1 items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm",
            pathname === "/settings" ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <SettingsIcon className="size-4 shrink-0" />
          <span className="truncate">{email}</span>
        </Link>
        <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
          <LogOutIcon className="size-4" />
        </Button>
      </div>
    </aside>
  );
}

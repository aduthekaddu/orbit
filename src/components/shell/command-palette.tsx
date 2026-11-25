"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Command, defaultFilter } from "cmdk";
import { BrainIcon, ChatCircleIcon, GearSixIcon, MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { chatLabel, type ChatSummary } from "@/components/chat/sidebar";
import { ShortcutKbd } from "./shortcuts";
import { useLoaded } from "@/lib/request-json";
import { paletteSearchNotice } from "./palette-search";

const itemClass =
  "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground";
const groupClass = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

// Chat items use the id as their cmdk value so duplicate titles stay distinct; match on the title alone.
function filter(value: string, search: string, keywords?: string[]) {
  return defaultFilter(keywords?.length ? keywords.join(" ") : value, search);
}

type MessageHit = { chatId: string; chatTitle: string; messageId: string; snippet: string };

const searchHits = z.object({ hits: z.array(z.unknown()) }).transform(({ hits }) =>
  hits.flatMap((hit) => {
    if (!hit || typeof hit !== "object") return [];
    const row = hit as Record<string, unknown>;
    if (
      typeof row.chatId !== "string" ||
      typeof row.chatTitle !== "string" ||
      typeof row.messageId !== "string" ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }
    return [{ chatId: row.chatId, chatTitle: row.chatTitle, messageId: row.messageId, snippet: row.snippet } satisfies MessageHit];
  }),
);

export function CommandPalette({
  open,
  onOpenChange,
  chats,
  onNewChat,
  onAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: ChatSummary[];
  onNewChat: () => void;
  onAction: () => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [messageSearch, loadSearch, resetSearch] = useLoaded<MessageHit[]>({ status: "idle" });
  const hits = messageSearch.status === "done" ? messageSearch.data : [];
  const notice = paletteSearchNotice(messageSearch.status);

  useEffect(() => {
    if (!open) {
      setSearch("");
      resetSearch();
      return;
    }
    const query = search.trim();
    if (!query) {
      resetSearch();
      return;
    }
    resetSearch({ status: "pending" });
    const timer = window.setTimeout(() => {
      loadSearch(`/api/search?q=${encodeURIComponent(query)}`, {}, searchHits);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, search, loadSearch, resetSearch]);

  function run(action: () => void) {
    onOpenChange(false);
    onAction();
    action();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[15vh] translate-y-0 gap-0 overflow-hidden bg-popover p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command filter={filter} loop>
          <div className="flex items-center gap-2.5 border-b px-3.5">
            <MagnifyingGlassIcon weight="light" className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input value={search} onValueChange={setSearch} placeholder="Search" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <ScrollFade axis="y" fade="var(--popover)" scrollerClassName="max-h-[min(24rem,60vh)]">
            <Command.List className="p-1.5">
              {(notice === "empty") && (
                <Command.Empty className="py-8 text-center text-sm text-muted-foreground">No results</Command.Empty>
              )}
              <Command.Group className={groupClass}>
                <Command.Item value="New chat" onSelect={() => run(onNewChat)} className={itemClass}>
                  <NotePencilIcon weight="light" className="size-4" />
                  <span className="flex-1">New chat</span>
                  <ShortcutKbd name="newChat" />
                </Command.Item>
                <Command.Item value="Settings" onSelect={() => run(() => router.push("/settings"))} className={itemClass}>
                  <GearSixIcon weight="light" className="size-4" />
                  Settings
                </Command.Item>
                <Command.Item value="Memory" onSelect={() => run(() => router.push("/memory"))} className={itemClass}>
                  <BrainIcon weight="light" className="size-4" />
                  Memory
                </Command.Item>
              </Command.Group>
              {chats.length > 0 && (
                <Command.Group heading="Chats" className={groupClass}>
                  {chats.map((chat) => (
                    <Command.Item
                      key={chat.id}
                      value={chat.id}
                      keywords={[chatLabel(chat.title)]}
                      onSelect={() => run(() => router.push(`/c/${chat.id}`))}
                      className={itemClass}
                    >
                      <ChatCircleIcon weight="light" className="size-4 shrink-0" />
                      <span className="truncate">{chatLabel(chat.title)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {hits.length > 0 && (
                <Command.Group heading="Messages" className={groupClass}>
                  {hits.map((hit) => (
                    <Command.Item
                      key={hit.messageId}
                      value={hit.messageId}
                      keywords={[chatLabel(hit.chatTitle), hit.snippet, search]}
                      onSelect={() => run(() => router.push(`/c/${hit.chatId}?m=${encodeURIComponent(hit.messageId)}`))}
                      className="flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
                    >
                      <ChatCircleIcon weight="light" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{chatLabel(hit.chatTitle)}</span>
                        <span className="block truncate">{hit.snippet}</span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {notice === "failed" && <p className="py-8 text-center text-sm text-destructive">Could not search</p>}
            </Command.List>
          </ScrollFade>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

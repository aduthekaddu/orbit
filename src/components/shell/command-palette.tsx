"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Command, defaultFilter } from "cmdk";
import { BrainIcon, ChatCircleIcon, GearSixIcon, MagnifyingGlassIcon, NotePencilIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { chatLabel, type ChatSummary } from "@/components/chat/chat-row-menu";
import { ShortcutKbd } from "./shortcuts";
import { useLoaded } from "@/lib/request-json";
import type { Role } from "@/lib/session";
import { paletteSearchNotice } from "./palette-search";

const itemClass =
  "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground";
const groupClass = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

// Chat items use the id as their cmdk value so duplicate titles stay distinct; match on the title alone.
function filter(value: string, search: string, keywords?: string[]) {
  return defaultFilter(keywords?.length ? keywords.join(" ") : value, search);
}

// A snippet arrives as plain text split into parts; `match` marks the words the query found.
const messageHit = z.object({
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string(),
  snippet: z.array(z.object({ text: z.string(), match: z.boolean() })),
});
type MessageHit = z.infer<typeof messageHit>;

// A hit that does not parse is left out instead of failing the whole search.
const searchHits = z.object({ hits: z.array(z.unknown()) }).transform(({ hits }) =>
  hits.flatMap((hit) => {
    const parsed = messageHit.safeParse(hit);
    return parsed.success ? [parsed.data] : [];
  }),
);

function snippetText(snippet: MessageHit["snippet"]) {
  return snippet.map((part) => part.text).join("");
}

export function CommandPalette({
  open,
  onOpenChange,
  chats,
  role,
  hiddenChatIds,
  onNewChat,
  onAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: ChatSummary[];
  role: Role;
  /** Chats deleted or waiting for Undo. Their message hits stay out of the list. */
  hiddenChatIds: ReadonlySet<string>;
  onNewChat: () => void;
  onAction: () => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [messageSearch, loadSearch, , resetSearch] = useLoaded<MessageHit[]>({ status: "idle" });
  const hits = messageSearch.status === "done" ? messageSearch.data.filter((hit) => !hiddenChatIds.has(hit.chatId)) : [];
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
        <Command filter={filter} loop className="min-w-0">
          <div className="flex items-center gap-2.5 border-b px-3.5">
            <MagnifyingGlassIcon weight="light" className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input value={search} onValueChange={setSearch} placeholder="Search" className="h-12 flex-1 bg-transparent text-field outline-none placeholder:text-muted-foreground" />
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
                {role === "admin" ? (
                  <Command.Item value="Admin" onSelect={() => run(() => router.push("/admin"))} className={itemClass}>
                    <ShieldCheckIcon weight="light" className="size-4" />
                    Admin
                  </Command.Item>
                ) : null}
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
                      <span className="min-w-0 truncate">{chatLabel(chat.title)}</span>
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
                      keywords={[chatLabel(hit.chatTitle), snippetText(hit.snippet), search]}
                      onSelect={() => run(() => router.push(`/c/${hit.chatId}?m=${encodeURIComponent(hit.messageId)}`))}
                      className="flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
                    >
                      <ChatCircleIcon weight="light" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{chatLabel(hit.chatTitle)}</span>
                        <span className="block truncate">
                          {hit.snippet.map((part, index) =>
                            part.match ? (
                              <mark key={index} className="bg-transparent font-medium text-foreground">
                                {part.text}
                              </mark>
                            ) : (
                              <Fragment key={index}>{part.text}</Fragment>
                            ),
                          )}
                        </span>
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

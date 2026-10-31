"use client";

import { useRouter } from "next/navigation";
import { Command, defaultFilter } from "cmdk";
import { ChatCircleIcon, GearSixIcon, MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ChatSummary } from "@/components/chat/sidebar";
import { ShortcutKbd } from "./shortcuts";

const itemClass =
  "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground";
const groupClass = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

// Chat items use the id as their cmdk value so duplicate titles stay distinct; match on the title alone.
function filter(value: string, search: string, keywords?: string[]) {
  return defaultFilter(keywords?.length ? keywords.join(" ") : value, search);
}

export function CommandPalette({
  open,
  onOpenChange,
  chats,
  onNewChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: ChatSummary[];
  onNewChat: () => void;
}) {
  const router = useRouter();

  function run(action: () => void) {
    onOpenChange(false);
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
            <Command.Input placeholder="Search" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <Command.List className="scrollbar-thin max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">No results</Command.Empty>
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
            </Command.Group>
            {chats.length > 0 && (
              <Command.Group heading="Chats" className={groupClass}>
                {chats.map((chat) => (
                  <Command.Item
                    key={chat.id}
                    value={chat.id}
                    keywords={[chat.title]}
                    onSelect={() => run(() => router.push(`/c/${chat.id}`))}
                    className={itemClass}
                  >
                    <ChatCircleIcon weight="light" className="size-4 shrink-0" />
                    <span className="truncate">{chat.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

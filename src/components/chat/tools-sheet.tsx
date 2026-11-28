"use client";

import { createContext, useContext, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { z } from "zod";
import { PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { toolIcon } from "@/components/tools/tool-icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useDesktop } from "@/components/use-desktop";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";

/** A tool the chat may turn off. Not limited to built-in ids, so Slice 23 can add `mcp:<serverId>` entries. */
export type AvailableTool = { id: string; label: string };

type ToolsState = {
  // draft: no chats row yet, so a switch changes only `committed`. creating: the first send is making the row, so the
  // switches lock until its reply id proves the row exists. saved: each change goes out as PATCH /api/chats/[id].
  phase: "draft" | "creating" | "saved";
  // Tools this chat turned off, as the server holds them, or as a draft will send them.
  committed: ReadonlySet<string>;
  // id to off: what the PATCH in flight changes, and the clicks made since.
  inFlight: ReadonlyMap<string, boolean> | null;
  pending: ReadonlyMap<string, boolean>;
  failed: boolean;
};

type ToolsStore = ReturnType<typeof createToolsStore>;

const savedChat = z.object({ disabledTools: z.array(z.string()) });

function isOff(state: ToolsState, id: string) {
  return state.pending.get(id) ?? state.inFlight?.get(id) ?? state.committed.has(id);
}

// Clicks that end where the server already is send nothing.
function unsaved(changes: Iterable<[string, boolean]>, committed: ReadonlySet<string>) {
  return new Map([...changes].filter(([id, off]) => off !== committed.has(id)));
}

// Only the switches that moved, so the server keeps what another tab changed meanwhile.
function switches(changes: ReadonlyMap<string, boolean>) {
  const ids = (off: boolean) => [...changes].filter(([, value]) => value === off).map(([id]) => id).sort();
  return { toolsOff: ids(true), toolsOn: ids(false) };
}

/** One chat's tool switches. A saved chat sends one PATCH at a time and folds clicks made meanwhile into the next. */
export function createToolsStore({ chatId, initialDisabledTools, draft }: { chatId: string; initialDisabledTools: readonly string[]; draft: boolean }) {
  let state: ToolsState = { phase: draft ? "draft" : "saved", committed: new Set(initialDisabledTools), inFlight: null, pending: new Map(), failed: false };
  const listeners = new Set<() => void>();
  let flushes: (() => void)[] = [];

  function set(next: ToolsState) {
    state = next;
    for (const listener of listeners) listener();
    if (state.inFlight !== null || state.pending.size > 0) return;
    const done = flushes;
    flushes = [];
    for (const resolve of done) resolve();
  }

  function send() {
    if (state.phase !== "saved" || state.inFlight !== null || state.pending.size === 0) return;
    const carried = state.pending;
    set({ ...state, inFlight: carried, pending: new Map() });
    void requestJson(
      `/api/chats/${encodeURIComponent(chatId)}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(switches(carried)) },
      {
        parse: savedChat,
        onOk: (body) => {
          const committed = new Set(body.disabledTools);
          set({ ...state, committed, inFlight: null, pending: unsaved(state.pending, committed), failed: false });
          send();
        },
        // Only what the failed PATCH carried goes back. Clicks made while it was out still save.
        onFailed: () => {
          set({ ...state, inFlight: null, pending: unsaved(state.pending, state.committed), failed: true });
          send();
        },
      },
    );
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    toggle(id: string, on: boolean) {
      if (state.phase === "creating" || isOff(state, id) === !on) return;
      if (state.phase === "draft") {
        const committed = new Set(state.committed);
        if (on) committed.delete(id);
        else committed.add(id);
        set({ ...state, committed });
        return;
      }
      set({ ...state, pending: new Map(state.pending).set(id, !on) });
      send();
    },
    /** Settles once no PATCH is out or queued, whether the last one saved or failed. */
    flush() {
      if (state.inFlight === null && state.pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => flushes.push(resolve));
    },
    /** The list a draft's first send carries. A saved chat's send carries none, since the server reads its row. */
    draftDisabledTools: () => (state.phase === "saved" ? undefined : [...state.committed].sort()),
    sendStarted() {
      if (state.phase === "draft") set({ ...state, phase: "creating" });
    },
    sendFinished() {
      if (state.phase === "creating") set({ ...state, phase: "draft" });
    },
    // `stored` is the row's list when the page finds the chat saved after a send that lost its reply id.
    // Switches changed since then save on top of it.
    chatCreated(stored?: readonly string[]) {
      if (state.phase === "saved") return;
      const local = state.committed;
      const committed = stored ? new Set(stored) : local;
      const ids = new Set([...local, ...committed]);
      set({ ...state, phase: "saved", committed, pending: unsaved([...ids].map((id) => [id, local.has(id)]), committed) });
      send();
    },
  };
}

type Tools = { store: ToolsStore; availableTools: AvailableTool[] };

const ToolsContext = createContext<Tools | null>(null);

export function ToolsProvider({ store, availableTools, children }: Tools & { children: ReactNode }) {
  return <ToolsContext.Provider value={{ store, availableTools }}>{children}</ToolsContext.Provider>;
}

function useToolsState(store: ToolsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The composer's + button. It opens a popover on desktop and a bottom sheet on phones. */
export function ToolsTrigger() {
  const tools = useContext(ToolsContext);
  return tools ? <Trigger {...tools} /> : null;
}

function Trigger({ store, availableTools }: Tools) {
  const state = useToolsState(store);
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const offCount = availableTools.filter((tool) => isOff(state, tool.id)).length;

  const button = (
    <button
      type="button"
      data-tools-trigger
      aria-label={offCount > 0 ? `Tools (${offCount} off)` : "Tools"}
      className="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-focus focus-visible:ring-ring/50 data-[state=open]:border-border-strong data-[state=open]:text-foreground"
    >
      <PlusIcon weight="regular" className="size-4" />
      {offCount > 0 ? <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-sun" /> : null}
    </button>
  );

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{button}</PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          collisionPadding={8}
          aria-label="Tools"
          data-tools-sheet="popover"
          className="flex max-h-[min(var(--spacing-picker-height),var(--radix-popover-content-available-height))] w-64 flex-col overflow-hidden"
        >
          <ToolsPanel layout="popover" />
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{button}</SheetTrigger>
      <SheetContent data-tools-sheet="sheet">
        <SheetTitle className="border-b px-4 py-3">Tools</SheetTitle>
        <ToolsPanel layout="sheet" />
      </SheetContent>
    </Sheet>
  );
}

export function ToolsPanel({ layout }: { layout: "popover" | "sheet" }) {
  const tools = useContext(ToolsContext);
  if (!tools) throw new Error("ToolsPanel needs a ToolsProvider");
  const { store, availableTools } = tools;
  const state = useToolsState(store);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {availableTools.length === 0 ? (
          <p className="px-3 py-3 text-meta text-muted-foreground">No tools available</p>
        ) : (
          <ul>
            {availableTools.map((tool) => (
              <ToolSwitch
                key={tool.id}
                tool={tool}
                on={!isOff(state, tool.id)}
                locked={state.phase === "creating"}
                layout={layout}
                onChange={(on) => store.toggle(tool.id, on)}
              />
            ))}
          </ul>
        )}
        {state.failed ? (
          <div role="alert" className="flex items-center gap-2 px-2 py-1.5 text-meta text-destructive">
            <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
            Could not save tools.
          </div>
        ) : null}
      </div>
      <div className="flex justify-end border-t px-2 py-1.5">
        <Button asChild variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground max-sm:min-h-touch">
          <Link href="/tools">Tools</Link>
        </Button>
      </div>
    </>
  );
}

function ToolSwitch({
  tool,
  on,
  locked,
  layout,
  onChange,
}: {
  tool: AvailableTool;
  on: boolean;
  locked: boolean;
  layout: "popover" | "sheet";
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const Icon = toolIcon(tool.id);
  return (
    <li className={cn("flex items-center gap-3 rounded-md px-2", layout === "sheet" ? "min-h-touch" : "min-h-9 pointer-coarse:min-h-touch")}>
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm text-foreground">
        <Icon weight="regular" className="size-4 shrink-0 text-muted-foreground" />
        <span id={`${id}-label`} className="truncate">{tool.label}</span>
      </label>
      <Switch id={id} aria-labelledby={`${id}-label`} checked={on} disabled={locked} onCheckedChange={onChange} />
    </li>
  );
}

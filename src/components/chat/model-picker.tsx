"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckIcon, MagnifyingGlassIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { EffortGrid } from "@/components/effort-grid";
import { ModelBadges } from "@/components/model-badges";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useDesktop } from "@/components/use-desktop";
import { listOf, loadedList, useModelLists, type ModelLists } from "@/components/use-model-lists";
import type { PublicConnection } from "@/lib/connections";
import { DEFAULT_EFFORT, effortLevels, type Effort } from "@/lib/effort";
import type { ModelChoice } from "@/lib/model-choice";
import type { ListedModel } from "@/lib/model-list";
import { choiceLabel, modelLevels, SEARCH_AFTER_ROWS, shownModels, switchModel, type ModelList } from "@/lib/model-picker";
import type { Loaded } from "@/lib/request-json";
import { cn } from "@/lib/utils";

type Picker = {
  choice: ModelChoice | null;
  choose: (choice: ModelChoice) => void;
  connections: PublicConnection[];
  lists: ModelLists;
  load: (connectionId: string) => void;
  known: KnownLevels | null;
};

// The levels the server knew for the choice it resolved, so the chip reads right before the list loads.
type KnownLevels = { connectionId: string; model: string; levels: Effort[] | null };

type Layout = "popover" | "sheet";

const PickerContext = createContext<Picker | null>(null);

function usePicker() {
  const picker = useContext(PickerContext);
  if (!picker) throw new Error("The model picker needs a ModelChoiceProvider with a choice");
  return picker;
}

/** The chat's pending choice. It starts from the chat's pinned choice or the defaults, and every send carries it.
 * It is null when neither resolves, and the chip still opens the picker so the user can pick a model. */
export function ModelChoiceProvider({
  choice,
  onChoose,
  connections,
  known,
  children,
}: {
  choice: ModelChoice | null;
  onChoose: (choice: ModelChoice) => void;
  connections: PublicConnection[];
  known: KnownLevels | null;
  children: ReactNode;
}) {
  const { lists, load } = useModelLists();
  const knownConnection = known?.connectionId;
  // The route knows a model's levels only after its list loads once since the server started.
  useEffect(() => {
    if (knownConnection) load(knownConnection);
  }, [knownConnection, load]);
  return <PickerContext.Provider value={{ choice, choose: onChoose, connections, lists, load, known }}>{children}</PickerContext.Provider>;
}

function choiceLevels({ choice, connections, lists, known }: Picker): Effort[] | null {
  if (!choice) return [];
  const connection = connections.find((item) => item.id === choice.connectionId);
  const list = loadedList(listOf(lists, choice.connectionId));
  if (connection && list) return modelLevels(connection.kind, list, choice.model);
  return known?.connectionId === choice.connectionId && known.model === choice.model ? known.levels : null;
}

const chipClass =
  "min-w-0 cursor-pointer rounded-full border px-2 py-0.5 font-mono text-meta text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:border-border-strong data-[state=open]:text-foreground";

export function ModelChip() {
  const picker = useContext(PickerContext);
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  if (!picker) return <span />;
  const { choice, connections, load } = picker;
  const levels = choiceLevels(picker);
  const label = choice ? choiceLabel(choice.model, levels?.length === 0 ? null : choice.effort) : "Model";

  function openChange(next: boolean) {
    setOpen(next);
    if (next) for (const item of connections) load(item.id);
  }

  const chip = (
    <button type="button" data-model-chip className={chipClass}>
      <span className="block truncate">{label}</span>
    </button>
  );

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={openChange}>
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
        <PopoverContent side="top" align="start" collisionPadding={8} data-model-picker="popover" className="flex max-h-[min(var(--spacing-picker-height),var(--radix-popover-content-available-height))] w-picker flex-col overflow-hidden">
          <PickerPanel layout="popover" />
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Sheet open={open} onOpenChange={openChange}>
      <SheetTrigger asChild>{chip}</SheetTrigger>
      <SheetContent data-model-picker="sheet">
        <SheetTitle className="sr-only">Model</SheetTitle>
        <PickerPanel layout="sheet" />
      </SheetContent>
    </Sheet>
  );
}

function PickerPanel({ layout }: { layout: Layout }) {
  const picker = usePicker();
  const { choice, choose, connections, lists, load } = picker;
  const [query, setQuery] = useState("");
  const rowCount = connections.reduce((count, connection) => {
    const list = loadedList(listOf(lists, connection.id));
    return count + (list ? shownModels(list).length : 0);
  }, 0);
  const levels = choiceLevels(picker);

  return (
    <>
      {rowCount > SEARCH_AFTER_ROWS ? (
        <div className="border-b p-2">
          <div className="flex items-center gap-2 rounded-md border bg-surface-sunken px-2.5 focus-within:border-border-strong">
            <MagnifyingGlassIcon weight="regular" className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="search"
              data-model-search
              aria-label="Search models"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              className="h-9 min-w-0 flex-1 bg-transparent text-field outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {connections.length === 0 ? (
          <div className="flex justify-center p-3">
            <Button asChild variant="outline" size="sm">
              <Link href="/settings#connections">Add connection</Link>
            </Button>
          </div>
        ) : null}
        {connections.map((connection) => (
          <ConnectionGroup
            key={connection.id}
            connection={connection}
            list={listOf(lists, connection.id)}
            query={query}
            choice={choice}
            layout={layout}
            onRetry={() => load(connection.id)}
            onPick={(model) => choose(switchModel(choice?.effort ?? DEFAULT_EFFORT, connection.id, model.id, effortLevels(connection.kind, model.caps)))}
          />
        ))}
      </div>
      <div className="border-t p-2">
        <EffortGrid aria-label="Effort" value={choice?.effort ?? DEFAULT_EFFORT} levels={levels} onChange={(effort) => choice && choose({ ...choice, effort })} className={layout === "sheet" ? "[&>button]:h-11" : undefined} />
      </div>
      <div className="flex justify-end border-t px-2 py-1.5">
        <Button asChild variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground">
          <Link href="/settings#models">Manage</Link>
        </Button>
      </div>
    </>
  );
}

function ConnectionGroup({
  connection,
  list,
  query,
  choice,
  layout,
  onPick,
  onRetry,
}: {
  connection: PublicConnection;
  list: Loaded<ModelList>;
  query: string;
  choice: ModelChoice | null;
  layout: Layout;
  onPick: (model: ListedModel) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const loaded = loadedList(list);
  const models = loaded ? shownModels(loaded, query) : [];
  return (
    <section aria-labelledby={headingId} data-connection-group={connection.id} className="py-1">
      <h3 id={headingId} className="truncate px-2 pt-1 pb-1.5 text-meta text-muted-foreground">
        {connection.label}
      </h3>
      {list.status === "failed" ? (
        <div role="alert" className="flex items-center gap-2 px-2 py-1 text-meta text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{(list.failure.kind === "http" && list.failure.error) || "Could not load models."}</span>
          <Button variant="outline" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : !loaded ? (
        <div role="status" aria-label="Loading models" className="flex flex-col gap-2 px-2 py-1.5">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      ) : models.length === 0 ? (
        <p className="px-2 py-1.5 text-meta text-muted-foreground">No models</p>
      ) : (
        <ul>
          {models.map((model) => (
            <li key={model.id}>
              <ModelRow model={model} current={choice?.connectionId === connection.id && choice.model === model.id} layout={layout} onPick={() => onPick(model)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ModelRow({ model, current, layout, onPick }: { model: ListedModel; current: boolean; layout: Layout; onPick: () => void }) {
  const badgesId = useId();
  return (
    <button
      type="button"
      data-model-option={model.id}
      aria-pressed={current}
      aria-label={model.id}
      aria-describedby={badgesId}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-150 ease-orbit hover:bg-accent focus-visible:bg-accent",
        layout === "sheet" ? "min-h-11" : "min-h-8",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{model.id}</span>
      <ModelBadges caps={model.caps} id={badgesId} />
      <CheckIcon weight="regular" aria-hidden className={cn("size-3.5 shrink-0", current ? "text-foreground" : "invisible")} />
    </button>
  );
}

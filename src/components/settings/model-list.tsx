"use client";

import { useState } from "react";
import { MagnifyingGlassIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { ModelBadges } from "@/components/model-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { listOf, loadedList, type ModelLists } from "@/components/use-model-lists";
import type { PublicConnection } from "@/lib/connections";
import type { ListedModel } from "@/lib/model-list";
import { SEARCH_AFTER_ROWS, searchModels, type ModelList } from "@/lib/model-picker";
import { requestJson, type Loaded } from "@/lib/request-json";
import { cn } from "@/lib/utils";

const hiddenBody = z.object({ hidden: z.array(z.string()) });

export function ModelListSettings({
  connections,
  lists,
  onRetry,
  onHidden,
}: {
  connections: PublicConnection[];
  lists: ModelLists;
  onRetry: (connectionId: string) => void;
  onHidden: (connectionId: string, hidden: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const rows = connections.reduce((count, connection) => count + (loadedList(listOf(lists, connection.id))?.models.length ?? 0), 0);
  if (connections.length === 0) return null;
  return (
    <section id="models" aria-labelledby="models-heading" className="scroll-mt-6 rounded-xl border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-2.5">
        <h2 id="models-heading" className="py-1 text-sm font-medium">
          Models
        </h2>
        {rows > SEARCH_AFTER_ROWS ? (
          <div className="flex min-w-0 max-w-56 flex-1 items-center gap-2 rounded-md border bg-surface-sunken px-2.5 focus-within:border-border-strong">
            <MagnifyingGlassIcon weight="regular" className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="Search models"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              className="h-8 min-w-0 flex-1 bg-transparent text-field outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
      </div>
      <div className="divide-y">
        {connections.map((connection) => (
          <ConnectionModels
            key={connection.id}
            connection={connection}
            list={listOf(lists, connection.id)}
            query={query}
            onRetry={() => onRetry(connection.id)}
            onHidden={(hidden) => onHidden(connection.id, hidden)}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectionModels({
  connection,
  list,
  query,
  onRetry,
  onHidden,
}: {
  connection: PublicConnection;
  list: Loaded<ModelList>;
  query: string;
  onRetry: () => void;
  onHidden: (hidden: string[]) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = loadedList(list);
  const hidden = new Set(loaded?.hidden ?? []);
  const models = loaded ? searchModels(loaded.models, query) : [];

  function toggle(model: ListedModel, show: boolean) {
    if (saving) return;
    setSaving(model.id);
    setError(null);
    void requestJson(
      `/api/connections/${encodeURIComponent(connection.id)}/hidden-models`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: model.id, hidden: !show }) },
      {
        parse: hiddenBody,
        onOk: (body) => {
          setSaving(null);
          onHidden(body.hidden);
        },
        onFailed: (failure) => {
          setSaving(null);
          setError((failure.kind === "http" && failure.error) || "Could not save.");
        },
      },
    );
  }

  return (
    <div data-connection-models={connection.id} className="py-2">
      <div className="flex items-center justify-between gap-3 px-5 pt-1 pb-1.5">
        <h3 className="min-w-0 truncate text-meta text-muted-foreground">{connection.label}</h3>
        <ListStatus list={list} />
      </div>
      {list.status === "failed" ? (
        <div role="alert" className="flex items-center gap-2 px-5 py-1.5 text-meta text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{(list.failure.kind === "http" && list.failure.error) || "Could not load models."}</span>
          <Button variant="outline" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : !loaded ? (
        <div role="status" aria-label="Loading models" className="flex flex-col gap-2 px-5 py-1.5">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : models.length === 0 ? (
        <p className="px-5 py-1.5 text-meta text-muted-foreground">No models</p>
      ) : (
        <ul className="max-h-picker-height overflow-y-auto scrollbar-thin">
          {models.map((model) => (
            <li key={model.id} className="flex min-h-10 items-center gap-3 px-5 py-1">
              <span className="min-w-0 flex-1 truncate text-sm">{model.id}</span>
              <ModelBadges caps={model.caps} />
              <Switch
                aria-label={model.id}
                data-model-shown={model.id}
                checked={!hidden.has(model.id)}
                disabled={saving !== null}
                onCheckedChange={(show) => toggle(model, show)}
              />
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="flex items-center gap-2 px-5 pt-1.5 text-meta text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

const STATUS_DOT: Record<Loaded<ModelList>["status"], string> = {
  idle: "bg-warning motion-safe:animate-pulse",
  pending: "bg-warning motion-safe:animate-pulse",
  revalidating: "bg-positive",
  done: "bg-positive",
  failed: "bg-destructive",
};

function ListStatus({ list }: { list: Loaded<ModelList> }) {
  const loaded = loadedList(list);
  return (
    <span data-list-status={list.status} aria-live="polite" className="flex shrink-0 items-center gap-2 text-meta text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[list.status])} />
      {list.status === "failed" ? "Failed" : loaded ? (
        <span>
          <span className="num text-foreground">{loaded.models.length}</span> {loaded.models.length === 1 ? "model" : "models"}
        </span>
      ) : "Checking"}
    </span>
  );
}

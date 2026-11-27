"use client";

import { useEffect, useReducer, useState } from "react";
import { CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { EffortGrid } from "@/components/effort-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listOf, loadedList, type ModelLists } from "@/components/use-model-lists";
import type { ModelDefaults, PickableConnection } from "@/lib/connections";
import { DEFAULT_EFFORT, sentEffort, type Effort } from "@/lib/effort";
import { CUSTOM_OPTION, NO_OPTION, modelDefaultsBody, modelLevels, selectedOptionIndex, showsModelInput, switchModel } from "@/lib/model-picker";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { idleSubmit, submitTransition } from "@/lib/submit-state";
import { cn } from "@/lib/utils";
import { Row } from "./row";

type Draft = { connectionId: string | null; model: string; custom: boolean };

export function DefaultModelSettings({
  connections,
  defaults,
  lists,
  onRetry,
  onSaved,
}: {
  connections: PickableConnection[];
  defaults: ModelDefaults;
  lists: ModelLists;
  onRetry: (connectionId: string) => void;
  onSaved: (defaults: ModelDefaults) => void;
}) {
  // The model belongs to the connection it was chosen for, so a draft never pairs a model with another connection.
  const [draft, setDraft] = useState<Draft>({ connectionId: defaults.connectionId, model: defaults.model ?? "", custom: false });
  const [effort, setEffort] = useState<Effort>(defaults.effort ?? DEFAULT_EFFORT);
  const [save, dispatchSave] = useReducer(submitTransition, idleSubmit);
  const latestSave = useLatestRequest();

  useEffect(() => {
    if (save.status !== "succeeded") return;
    const timer = setTimeout(() => dispatchSave({ type: "edit" }), 2000);
    return () => clearTimeout(timer);
  }, [save.status]);

  // A deleted connection leaves the form on the first one that remains, with no model chosen.
  const found = connections.find((item) => item.id === draft.connectionId) ?? connections[0];
  if (!found) return null;
  const connection = found;
  const { model, custom: customMode } = draft.connectionId === connection.id ? draft : { model: "", custom: false };
  const write = (next: Omit<Draft, "connectionId">) => setDraft({ connectionId: connection.id, ...next });
  const list = listOf(lists, connection.id);
  const loaded = loadedList(list);
  const hidden = new Set(loaded?.hidden ?? []);
  // A default may name a hidden model, so it stays in the list while chosen.
  const options = loaded ? loaded.models.filter((item) => !hidden.has(item.id) || item.id === model) : [];
  const selectedIndex = selectedOptionIndex(options, model, customMode);
  const typed = model.trim();
  const levels = modelLevels(connection.kind, loaded, typed);
  // Keep the requested effort for models with no effort control so it can carry over to another model.
  const selectedEffort = sentEffort(effort, levels) ?? effort;
  const pending = save.status === "pending";

  function edit() {
    dispatchSave({ type: "edit" });
  }

  function chooseModel(id: string) {
    edit();
    write({ model: id, custom: false });
    setEffort((current) => switchModel(current, connection.id, id, modelLevels(connection.kind, loaded, id)).effort);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !typed) return;
    dispatchSave({ type: "submit" });
    void requestJson(
      "/api/preferences/model",
      {
        method: "PUT",
        signal: latestSave(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id, model: typed, effort: selectedEffort }),
      },
      {
        parse: modelDefaultsBody,
        onOk: (saved) => {
          dispatchSave({ type: "succeed" });
          onSaved(saved);
        },
        onFailed: (failure) => dispatchSave({ type: "fail", error: (failure.kind === "http" && failure.error) || "Could not save" }),
      },
    );
  }

  return (
    <form onSubmit={submit} aria-labelledby="default-model-heading" className="rounded-xl border bg-card shadow-card">
      <div className="border-b px-5 py-3.5">
        <h2 id="default-model-heading" className="text-sm font-medium">
          Default model
        </h2>
      </div>
      <div className="divide-y">
        <Row id="default-connection" label="Connection">
          <Select
            value={connection.id}
            onValueChange={(id) => {
              edit();
              setDraft({ connectionId: id, model: "", custom: false });
            }}
          >
            <SelectTrigger id="default-connection" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connections.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row id="default-model" label="Model" labelledControl={false}>
          <div className="flex min-w-0 flex-col gap-2">
            {list.status === "failed" ? (
              <p role="alert" className="flex items-center gap-2 text-meta text-destructive">
                <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{(list.failure.kind === "http" && list.failure.error) || "Could not load models."}</span>
                <Button type="button" variant="outline" size="xs" onClick={() => onRetry(connection.id)}>
                  Retry
                </Button>
              </p>
            ) : null}
            {!loaded && list.status !== "failed" ? (
              <Skeleton role="status" aria-label="Loading models" className="h-9 w-full" />
            ) : null}
            {options.length > 0 ? (
              <Select
                value={selectedIndex === NO_OPTION ? "" : String(selectedIndex)}
                onValueChange={(value) => {
                  const option = options[Number(value)];
                  if (!option) {
                    edit();
                    write({ model: selectedIndex === CUSTOM_OPTION ? model : "", custom: true });
                    return;
                  }
                  chooseModel(option.id);
                }}
              >
                <SelectTrigger aria-labelledby="default-model-label" className="w-full min-w-0">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((item, index) => (
                    <SelectItem key={item.id} value={String(index)}>
                      {item.id}
                    </SelectItem>
                  ))}
                  <SelectItem value={String(CUSTOM_OPTION)}>Custom</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {(loaded || list.status === "failed") && showsModelInput(options, model, customMode) ? (
              <Input
                aria-label={options.length === 0 ? undefined : "Custom model"}
                aria-labelledby={options.length === 0 ? "default-model-label" : undefined}
                value={model}
                maxLength={200}
                autoComplete="off"
                required
                onChange={(event) => {
                  edit();
                  write({ model: event.target.value, custom: true });
                }}
              />
            ) : null}
          </div>
        </Row>
        <Row id="default-effort" label="Effort" labelledControl={false}>
          <EffortGrid aria-labelledby="default-effort-label" value={selectedEffort} levels={levels} onChange={(next) => { edit(); setEffort(next); }} />
        </Row>
      </div>
      <div className="flex items-center justify-end gap-3 border-t px-5 py-3">
        {save.status === "failed" ? (
          <p role="alert" className="mr-auto flex min-w-0 items-center gap-2 text-meta text-destructive">
            <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
            <span className="truncate">{save.error}</span>
          </p>
        ) : null}
        <span
          aria-live="polite"
          className={cn("flex items-center gap-1.5 text-meta text-muted-foreground transition-opacity duration-200 ease-orbit", save.status === "succeeded" ? "opacity-100" : "opacity-0")}
        >
          {save.status === "succeeded" ? (
            <>
              <CheckIcon weight="regular" className="size-3.5 text-positive" />
              Saved
            </>
          ) : null}
        </span>
        <Button type="submit" size="sm" disabled={pending || !typed}>
          Save
        </Button>
      </div>
    </form>
  );
}

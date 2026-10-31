"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { PublicSettings, ReasoningEffort } from "@/lib/settings";

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const CUSTOM = "__custom__";

type ListedModel = { id: string; reasoning: boolean | null };

type Connection =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; models: ListedModel[] }
  | { status: "failed" };

function canLoadStored(initial: PublicSettings) {
  return initial.keySet && Boolean(initial.baseUrl);
}

export function SettingsForm({ initial }: { initial: PublicSettings }) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [keySet, setKeySet] = useState(initial.keySet);
  const [connection, setConnection] = useState<Connection>(() =>
    canLoadStored(initial) ? { status: "checking" } : { status: "idle" },
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const latestLoad = useRef(0);

  async function loadModels(nextBase = baseUrl, nextKey = apiKey) {
    const key = nextKey.trim();
    if (!key && !keySet) {
      setConnection({ status: "idle" });
      return;
    }
    const load = ++latestLoad.current;
    setConnection({ status: "checking" });
    let next: Connection;
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: nextBase || undefined,
          apiKey: nextKey || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { models?: ListedModel[] };
      next = response.ok ? { status: "connected", models: body.models ?? [] } : { status: "failed" };
    } catch {
      next = { status: "failed" };
    }
    // Blur on two fields can race; only the newest request may settle the state.
    if (load === latestLoad.current) setConnection(next);
  }

  useEffect(() => {
    if (canLoadStored(initial)) {
      void loadModels(initial.baseUrl, "");
    }
    // Load once from the stored provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSaved(false);
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey: apiKey || undefined,
        model,
        reasoningEffort: effort,
      }),
    });
    const body = (await response.json()) as PublicSettings & { error?: string };
    setPending(false);
    if (!response.ok) {
      setError(body.error ?? "Could not save");
      return;
    }
    setKeySet(body.keySet);
    setApiKey("");
    setSaved(true);
  }

  const models = connection.status === "connected" ? connection.models : [];
  const inList = models.some((item) => item.id === model);
  const selected = models.find((item) => item.id === model);
  const allowReasoning = !selected || selected.reasoning !== false;

  return (
    <div className="mx-auto w-full max-w-widget px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <form onSubmit={onSubmit} className="rounded-xl border bg-card shadow-card">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <h2 className="text-sm font-medium">Provider</h2>
          <ConnectionStatus connection={connection} />
        </div>
        <div className="divide-y">
          <Row id="baseUrl" label="Base URL">
            <Input
              id="baseUrl"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={() => void loadModels()}
              autoComplete="off"
              required
            />
          </Row>
          <Row id="apiKey" label="API key">
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              placeholder={keySet ? "Key set" : ""}
              onChange={(event) => setApiKey(event.target.value)}
              onBlur={() => void loadModels()}
              autoComplete="off"
            />
          </Row>
          <Row id="model" label="Model">
            <div className="flex flex-col gap-2">
              {models.length > 0 ? (
                <Select
                  value={inList ? model : CUSTOM}
                  onValueChange={(value) => {
                    if (value === CUSTOM) {
                      if (inList) setModel("");
                      return;
                    }
                    setModel(value);
                  }}
                >
                  <SelectTrigger id="model" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.id}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>Custom</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {models.length === 0 || !inList ? (
                <Input
                  id={models.length === 0 ? "model" : "model-custom"}
                  aria-label={models.length === 0 ? undefined : "Custom model"}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  autoComplete="off"
                  required
                />
              ) : null}
            </div>
          </Row>
          {allowReasoning ? (
            <Row id="effort" label="Reasoning" labelledControl={false}>
              <ToggleGroup
                type="single"
                variant="pill"
                size="sm"
                value={effort}
                onValueChange={(value) => {
                  const next = EFFORTS.find((item) => item.value === value);
                  if (next) setEffort(next.value);
                }}
                aria-labelledby="effort-label"
                className="rounded-full border bg-surface-sunken p-0.5"
              >
                {EFFORTS.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value} className="px-3">
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Row>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3 border-t px-5 py-3">
          {error ? (
            <p role="alert" className="mr-auto flex min-w-0 items-center gap-2 text-xs text-destructive">
              <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
              <span className="truncate">{error}</span>
            </p>
          ) : null}
          <span
            aria-live="polite"
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground transition-opacity duration-200 ease-orbit",
              saved ? "opacity-100" : "opacity-0",
            )}
          >
            {saved ? (
              <>
                <CheckIcon weight="regular" className="size-3.5 text-positive" />
                Saved
              </>
            ) : null}
          </span>
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

function Row({
  id,
  label,
  labelledControl = true,
  children,
}: {
  id: string;
  label: string;
  labelledControl?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 px-5 py-3.5 sm:grid-cols-[7rem_1fr] sm:items-center sm:gap-4">
      <Label
        id={`${id}-label`}
        htmlFor={labelledControl ? id : undefined}
        className="text-xs text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

const STATUS_DOT: Record<Connection["status"], string> = {
  idle: "bg-muted-foreground/40",
  checking: "bg-warning motion-safe:animate-pulse",
  connected: "bg-positive",
  failed: "bg-destructive",
};

function ConnectionStatus({ connection }: { connection: Connection }) {
  return (
    <span aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[connection.status])} />
      <ConnectionLabel connection={connection} />
    </span>
  );
}

function ConnectionLabel({ connection }: { connection: Connection }) {
  switch (connection.status) {
    case "idle":
      return "Not checked";
    case "checking":
      return "Checking";
    case "connected": {
      const count = connection.models.length;
      return (
        <span>
          <span className="num text-foreground">{count}</span> {count === 1 ? "model" : "models"}
        </span>
      );
    }
    case "failed":
      return "Failed";
  }
}

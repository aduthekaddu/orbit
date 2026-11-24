"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { CUSTOM_OPTION, NO_OPTION, selectedOptionIndex, showsModelInput, type ModelOption } from "@/lib/model-picker";
import { appliedSave, connectionFromResponse, type Connection, type SettingsSnapshot } from "@/lib/settings-form";
import type { PublicSettings, ReasoningEffort } from "@/lib/settings";

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];


function canLoadStored(initial: Pick<PublicSettings, "baseUrl" | "keySet">) {
  return initial.keySet && Boolean(initial.baseUrl);
}

export function SettingsForm({ initial, title }: { initial: PublicSettings; title: string }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [searxngUrl, setSearxngUrl] = useState(initial.searxngUrl);
  const [tavilyApiKey, setTavilyApiKey] = useState<string | null>("");
  const [tavilyKeySet, setTavilyKeySet] = useState(initial.tavilyKeySet);
  const [githubToken, setGithubToken] = useState<string | null>("");
  const [githubTokenSet, setGithubTokenSet] = useState(initial.githubTokenSet);
  const [githubMcpUrl, setGithubMcpUrl] = useState(initial.githubMcpUrl);
  const [githubCheck, setGithubCheck] = useState<GithubCheck>({ status: "idle" });
  const githubCheckRequest = useRef(0);
  const [keySet, setKeySet] = useState(initial.keySet);
  const hasKey = keySet || apiKey.trim().length > 0;
  const [connection, setConnection] = useState<Connection>(() => canLoadStored(initial) ? { status: "checking" } : { status: "idle" });
  const [customMode, setCustomMode] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const modelLoad = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const formValues: SettingsSnapshot = { baseUrl, apiKey, model, effort, searxngUrl, tavilyApiKey, githubToken, githubMcpUrl };
  const latestValues = useRef(formValues);
  latestValues.current = formValues;

  const loadModels = useCallback(async (nextBase: string, nextKey: string, nextHasKey: boolean) => {
    const id = ++modelLoad.current.id;
    modelLoad.current.controller?.abort();
    const controller = new AbortController();
    modelLoad.current.controller = controller;
    setConnection({ status: "checking" });
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          baseUrl: nextBase || undefined,
          apiKey: nextKey || undefined,
        }),
      });
      if (id !== modelLoad.current.id) return;
      const body = (await response.json().catch(() => ({}))) as { models?: ModelOption[] };
      if (id !== modelLoad.current.id) return;
      setConnection(connectionFromResponse(response, body, nextHasKey));
    } catch (error) {
      if (id !== modelLoad.current.id) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setConnection({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    if (canLoadStored({ baseUrl: initial.baseUrl, keySet: initial.keySet })) {
      void loadModels(initial.baseUrl, "", initial.keySet);
    }
    const load = modelLoad.current;
    return () => {
      load.controller?.abort();
    };
  }, [initial.baseUrl, initial.keySet, loadModels]);

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
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: formValues.baseUrl,
          apiKey: formValues.apiKey || undefined,
          model: formValues.model,
          reasoningEffort: formValues.effort,
          searxngUrl: formValues.searxngUrl.trim(),
          tavilyApiKey: formValues.tavilyApiKey === null ? null : formValues.tavilyApiKey || undefined,
          githubToken: formValues.githubToken === null ? null : formValues.githubToken || undefined,
          githubMcpUrl: formValues.githubMcpUrl.trim(),
        }),
      });
      const body = (await response.json()) as PublicSettings & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not save");
        return;
      }
      // Pages that read settings on the server stay in the router cache, so Back would show them stale.
      router.refresh();
      const applied = appliedSave(formValues, latestValues.current);
      if (applied.applyKeySet) setKeySet(body.keySet);
      if (applied.clearKey) setApiKey("");
      setTavilyKeySet(body.tavilyKeySet);
      if (applied.clearTavilyKey) setTavilyApiKey("");
      setGithubTokenSet(body.githubTokenSet);
      if (applied.clearGithubToken) setGithubToken("");
      if (applied.saved) setSaved(true);
    } catch {
      setError("Could not save");
    } finally {
      setPending(false);
    }
  }

  async function onCheckGithub() {
    const id = ++githubCheckRequest.current;
    setGithubCheck({ status: "checking" });
    try {
      const response = await fetch("/api/settings/github/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: (githubToken ?? "").trim() || undefined,
          mcpUrl: githubMcpUrl.trim(),
        }),
      });
      if (id !== githubCheckRequest.current) return;
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; login?: string; error?: string };
      if (id !== githubCheckRequest.current) return;
      if (body.ok && body.login) setGithubCheck({ status: "connected", login: body.login });
      else setGithubCheck({ status: "failed", error: body.error || "GitHub is unavailable." });
    } catch {
      if (id !== githubCheckRequest.current) return;
      setGithubCheck({ status: "failed", error: "GitHub is unavailable." });
    }
  }

  const models = connection.status === "connected" ? connection.models : [];
  const selectedIndex = selectedOptionIndex(models, model, customMode);
  const selected = models.find((item) => item.id === model);
  const allowReasoning = !selected || selected.reasoning !== false;

  return (
    <div className="mx-auto w-full max-w-widget px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">{title}</h1>
      <form onSubmit={onSubmit} className="rounded-xl border bg-card shadow-card">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <h2 className="text-sm font-medium">Provider</h2>
          <ConnectionStatus connection={connection} hasKey={hasKey} />
        </div>
        <div className="divide-y">
          <Row id="baseUrl" label="Base URL">
            <Input
              id="baseUrl"
              value={baseUrl}
              onChange={(event) => {
                setError("");
                setBaseUrl(event.target.value);
              }}
              onBlur={() => void loadModels(baseUrl, apiKey, hasKey)}
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
              onChange={(event) => {
                setError("");
                setApiKey(event.target.value);
              }}
              onBlur={() => void loadModels(baseUrl, apiKey, hasKey)}
              autoComplete="off"
            />
          </Row>
          <Row id="model" label="Model">
            <div className="flex flex-col gap-2">
              {models.length > 0 ? (
                <Select
                  required
                  value={selectedIndex === NO_OPTION ? "" : String(selectedIndex)}
                  onValueChange={(value) => {
                    setError("");
                    const option = models[Number(value)];
                    if (!option) {
                      setCustomMode(true);
                      if (selectedIndex !== CUSTOM_OPTION) setModel("");
                      return;
                    }
                    setCustomMode(false);
                    setModel(option.id);
                  }}
                >
                  <SelectTrigger id="model" className="w-full">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((item, index) => (
                      <SelectItem key={item.id} value={String(index)}>
                        {item.id}
                      </SelectItem>
                    ))}
                    <SelectItem value={String(CUSTOM_OPTION)}>Custom</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {showsModelInput(models, model, customMode) ? (
                <Input
                  id={models.length === 0 ? "model" : "model-custom"}
                  aria-label={models.length === 0 ? undefined : "Custom model"}
                  value={model}
                  onChange={(event) => {
                    setError("");
                    setCustomMode(true);
                    setModel(event.target.value);
                  }}
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
                  setError("");
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
        <div className="border-y px-5 py-3.5">
          <h2 className="text-sm font-medium">Search</h2>
        </div>
        <div className="divide-y">
          <Row id="searxngUrl" label="SearXNG URL">
            <Input id="searxngUrl" value={searxngUrl} autoComplete="off" onChange={(event) => { setError(""); setSearxngUrl(event.target.value); }} />
          </Row>
          <Row id="tavilyApiKey" label="Tavily key">
            <div className="flex min-w-0 items-center gap-2">
              <Input id="tavilyApiKey" type="password" value={tavilyApiKey ?? ""} placeholder={tavilyKeySet && tavilyApiKey !== null ? "Key set" : ""} autoComplete="off" onChange={(event) => { setError(""); setTavilyApiKey(event.target.value); }} />
              {tavilyKeySet && tavilyApiKey !== null ? (
                <Button type="button" variant="ghost" size="sm" aria-label="Remove Tavily key" disabled={pending} onClick={() => { setError(""); setSaved(false); setTavilyApiKey(null); }}>
                  Remove
                </Button>
              ) : null}
            </div>
          </Row>
        </div>
        <div className="flex items-center justify-between gap-3 border-y px-5 py-3.5">
          <h2 className="text-sm font-medium">GitHub</h2>
          <GithubCheckStatus check={githubCheck} />
        </div>
        <div className="divide-y">
          <Row id="githubToken" label="Token">
            <div className="flex min-w-0 items-center gap-2">
              <Input id="githubToken" type="password" value={githubToken ?? ""} placeholder={githubTokenSet && githubToken !== null ? "Key set" : ""} autoComplete="off" onChange={(event) => { setError(""); setGithubToken(event.target.value); }} />
              {githubTokenSet && githubToken !== null ? (
                <Button type="button" variant="ghost" size="sm" aria-label="Remove GitHub token" disabled={pending} onClick={() => { setError(""); setSaved(false); setGithubToken(null); }}>
                  Remove
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" disabled={githubCheck.status === "checking"} onClick={() => void onCheckGithub()}>
                Check
              </Button>
            </div>
          </Row>
          <Row id="githubMcpUrl" label="MCP URL">
            <Input id="githubMcpUrl" value={githubMcpUrl} autoComplete="off" onChange={(event) => { setError(""); setGithubMcpUrl(event.target.value); }} />
          </Row>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3.5">
          <h2 className="text-sm font-medium">Code sandbox</h2>
          <span data-sandbox-status={initial.sandbox ? "on" : "off"} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", initial.sandbox ? "bg-positive" : "bg-muted-foreground/40")} />
            {initial.sandbox ? "On" : "Off"}
          </span>
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

type GithubCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; login: string }
  | { status: "failed"; error: string };

function GithubCheckStatus({ check }: { check: GithubCheck }) {
  if (check.status === "idle") return null;
  const dot = check.status === "connected" ? "bg-positive" : check.status === "failed" ? "bg-destructive" : "bg-warning motion-safe:animate-pulse";
  return (
    <span data-github-status={check.status} aria-live="polite" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {check.status === "checking" ? "Checking" : null}
      {check.status === "connected" ? <span className="truncate">Connected <span className="text-foreground">{check.login}</span></span> : null}
      {check.status === "failed" ? <span className="truncate text-destructive">{check.error}</span> : null}
    </span>
  );
}

function ConnectionStatus({ connection, hasKey }: { connection: Connection; hasKey: boolean }) {
  return (
    <span aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[connection.status])} />
      {connection.status === "idle" && !hasKey ? "No key" : <ConnectionLabel connection={connection} />}
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

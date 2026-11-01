"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { PublicSettings, ReasoningEffort } from "@/lib/settings";

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

type ListedModel = { id: string; reasoning: boolean | null };

export function SettingsForm({ initial }: { initial: PublicSettings }) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<ReasoningEffort>(initial.reasoningEffort);
  const [keySet, setKeySet] = useState(initial.keySet);
  const [models, setModels] = useState<ListedModel[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const modelLoad = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });

  const loadModels = useCallback(async (nextBase: string, nextKey: string) => {
    const id = ++modelLoad.current.id;
    modelLoad.current.controller?.abort();
    const controller = new AbortController();
    modelLoad.current.controller = controller;
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
      const body = (await response.json().catch(() => ({}))) as { models?: ListedModel[] };
      if (id !== modelLoad.current.id) return;
      setModels(response.ok ? (body.models ?? []) : []);
    } catch (error) {
      if (id !== modelLoad.current.id) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setModels([]);
    }
  }, []);

  useEffect(() => {
    if (initial.keySet && initial.baseUrl) {
      void loadModels(initial.baseUrl, "");
    }
    return () => {
      modelLoad.current.controller?.abort();
    };
  }, [initial.baseUrl, initial.keySet, loadModels]);

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
          baseUrl,
          apiKey: apiKey || undefined,
          model,
          reasoningEffort: effort,
        }),
      });
      const body = (await response.json()) as PublicSettings & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not save");
        return;
      }
      setKeySet(body.keySet);
      setApiKey("");
      setSaved(true);
    } catch {
      setError("Could not save");
    } finally {
      setPending(false);
    }
  }

  const inList = models.some((item) => item.id === model);
  const selected = models.find((item) => item.id === model);
  const allowReasoning = !selected || selected.reasoning !== false;

  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-lg flex-col gap-5 p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="baseUrl">Base URL</Label>
        <Input
          id="baseUrl"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={() => void loadModels(baseUrl, apiKey)}
          autoComplete="off"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="apiKey">API key</Label>
        <Input
          id="apiKey"
          type="password"
          value={apiKey}
          placeholder={keySet ? "Key set" : ""}
          onChange={(event) => setApiKey(event.target.value)}
          onBlur={() => void loadModels(baseUrl, apiKey)}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="model">Model</Label>
        {models.length > 0 ? (
          <select
            id="model"
            value={inList ? model : "__custom__"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "__custom__") {
                if (inList) setModel("");
                return;
              }
              setModel(value);
            }}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
            <option value="__custom__">Custom</option>
          </select>
        ) : null}
        {models.length === 0 || !inList ? (
          <Input
            id={models.length === 0 ? "model" : "model-custom"}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            required
          />
        ) : null}
      </div>
      {allowReasoning ? (
        <div className="flex flex-col gap-3">
          <Label htmlFor="effort">Reasoning</Label>
          <Slider
            id="effort"
            min={0}
            max={2}
            step={1}
            value={[Math.max(0, EFFORTS.indexOf(effort))]}
            onValueChange={(value) => setEffort(EFFORTS[value[0] ?? 1] ?? "medium")}
            aria-label="Reasoning effort"
          />
          <div className="text-muted-foreground flex justify-between text-xs">
            <span>Low</span>
            <span>Medium</span>
            <span>High</span>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {saved ? <p className="text-sm">Saved</p> : null}
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

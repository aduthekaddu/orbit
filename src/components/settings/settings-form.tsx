"use client";

import { useEffect, useState } from "react";
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

  async function loadModels(nextBase = baseUrl, nextKey = apiKey) {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: nextBase || undefined,
        apiKey: nextKey || undefined,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { models?: ListedModel[] };
    setModels(response.ok ? (body.models ?? []) : []);
  }

  useEffect(() => {
    if (initial.keySet && initial.baseUrl) {
      void loadModels(initial.baseUrl, "");
    }
    // Load once from the stored provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          onBlur={() => void loadModels()}
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
          onBlur={() => void loadModels()}
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

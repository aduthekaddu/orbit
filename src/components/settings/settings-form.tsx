"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Row } from "./row";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { appliedSave, type SettingsSnapshot } from "@/lib/settings-form";
import { idleSubmit, submitTransition } from "@/lib/submit-state";
import type { PublicSettings } from "@/lib/settings";

const savedBody = z.object({ tavilyKeySet: z.boolean(), githubTokenSet: z.boolean() });
const githubCheckBody = z.object({ ok: z.boolean(), login: z.string().optional(), error: z.string().optional() });
const GITHUB_UNAVAILABLE = "GitHub is unavailable.";

export function SettingsForm({ initial }: { initial: PublicSettings }) {
  const router = useRouter();
  const [searxngUrl, setSearxngUrl] = useState(initial.searxngUrl);
  const [tavilyApiKey, setTavilyApiKey] = useState<string | null>("");
  const [tavilyKeySet, setTavilyKeySet] = useState(initial.tavilyKeySet);
  const [githubToken, setGithubToken] = useState<string | null>("");
  const [githubTokenSet, setGithubTokenSet] = useState(initial.githubTokenSet);
  const [githubMcpUrl, setGithubMcpUrl] = useState(initial.githubMcpUrl);
  const [githubCheck, setGithubCheck] = useState<GithubCheck>({ status: "idle" });
  const latestGithubCheck = useLatestRequest();
  const latestSave = useLatestRequest();
  const [save, dispatchSave] = useReducer(submitTransition, idleSubmit);
  const pending = save.status === "pending";
  const formValues: SettingsSnapshot = { searxngUrl, tavilyApiKey, githubToken, githubMcpUrl };
  const latestValues = useRef(formValues);
  latestValues.current = formValues;

  useEffect(() => {
    if (save.status !== "succeeded") return;
    const timer = setTimeout(() => dispatchSave({ type: "edit" }), 2000);
    return () => clearTimeout(timer);
  }, [save.status]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    dispatchSave({ type: "submit" });
    await requestJson(
      "/api/settings",
      {
        method: "PUT",
        signal: latestSave(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          searxngUrl: formValues.searxngUrl.trim(),
          tavilyApiKey: formValues.tavilyApiKey === null ? null : formValues.tavilyApiKey || undefined,
          githubToken: formValues.githubToken === null ? null : formValues.githubToken || undefined,
          githubMcpUrl: formValues.githubMcpUrl.trim(),
        }),
      },
      {
        parse: savedBody,
        onOk: (body) => {
          // Pages that read settings on the server stay in the router cache, so Back would show them stale.
          router.refresh();
          const applied = appliedSave(formValues, latestValues.current);
          setTavilyKeySet(body.tavilyKeySet);
          if (applied.clearTavilyKey) setTavilyApiKey("");
          setGithubTokenSet(body.githubTokenSet);
          if (applied.clearGithubToken) setGithubToken("");
          dispatchSave({ type: "succeed" });
          if (!applied.saved) dispatchSave({ type: "edit" });
        },
        onFailed: (failure) =>
          dispatchSave({ type: "fail", error: (failure.kind === "http" && failure.error) || "Could not save" }),
      },
    );
  }

  function onCheckGithub() {
    setGithubCheck({ status: "checking" });
    void requestJson(
      "/api/settings/github/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: latestGithubCheck(),
        body: JSON.stringify({
          token: (githubToken ?? "").trim() || undefined,
          mcpUrl: githubMcpUrl.trim(),
        }),
      },
      {
        parse: githubCheckBody,
        onOk: (body) =>
          setGithubCheck(body.ok && body.login ? { status: "connected", login: body.login } : { status: "failed", error: body.error || GITHUB_UNAVAILABLE }),
        onFailed: (failure) => setGithubCheck({ status: "failed", error: (failure.kind === "http" && failure.error) || GITHUB_UNAVAILABLE }),
      },
    );
  }

  return (
      <form onSubmit={onSubmit} className="rounded-xl border bg-card shadow-card">
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-medium">Search</h2>
        </div>
        <div className="divide-y">
          <Row id="searxngUrl" label="SearXNG URL">
            <Input id="searxngUrl" value={searxngUrl} autoComplete="off" onChange={(event) => { dispatchSave({ type: "edit" }); setSearxngUrl(event.target.value); }} />
          </Row>
          <Row id="tavilyApiKey" label="Tavily key">
            <div className="flex min-w-0 items-center gap-2">
              <Input id="tavilyApiKey" type="password" value={tavilyApiKey ?? ""} placeholder={tavilyKeySet && tavilyApiKey !== null ? "Key set" : ""} autoComplete="off" onChange={(event) => { dispatchSave({ type: "edit" }); setTavilyApiKey(event.target.value); }} />
              {tavilyKeySet && tavilyApiKey !== null ? (
                <Button type="button" variant="ghost" size="sm" aria-label="Remove Tavily key" disabled={pending} onClick={() => { dispatchSave({ type: "edit" }); setTavilyApiKey(null); }}>
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
              <Input id="githubToken" type="password" value={githubToken ?? ""} placeholder={githubTokenSet && githubToken !== null ? "Key set" : ""} autoComplete="off" onChange={(event) => { dispatchSave({ type: "edit" }); setGithubToken(event.target.value); }} />
              {githubTokenSet && githubToken !== null ? (
                <Button type="button" variant="ghost" size="sm" aria-label="Remove GitHub token" disabled={pending} onClick={() => { dispatchSave({ type: "edit" }); setGithubToken(null); }}>
                  Remove
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" disabled={githubCheck.status === "checking"} onClick={onCheckGithub}>
                Check
              </Button>
            </div>
          </Row>
          <Row id="githubMcpUrl" label="MCP URL">
            <Input id="githubMcpUrl" value={githubMcpUrl} autoComplete="off" onChange={(event) => { dispatchSave({ type: "edit" }); setGithubMcpUrl(event.target.value); }} />
          </Row>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3.5">
          <h2 className="text-sm font-medium">Code sandbox</h2>
          <span data-sandbox-status={initial.sandbox ? "on" : "off"} className="flex items-center gap-2 text-meta text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", initial.sandbox ? "bg-positive" : "bg-muted-foreground/40")} />
            {initial.sandbox ? "On" : "Off"}
          </span>
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
            className={cn(
              "flex items-center gap-1.5 text-meta text-muted-foreground transition-opacity duration-200 ease-orbit",
              save.status === "succeeded" ? "opacity-100" : "opacity-0",
            )}
          >
            {save.status === "succeeded" ? (
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
  );
}

type GithubCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; login: string }
  | { status: "failed"; error: string };

function GithubCheckStatus({ check }: { check: GithubCheck }) {
  if (check.status === "idle") return null;
  const dot = check.status === "connected" ? "bg-positive" : check.status === "failed" ? "bg-destructive" : "bg-warning motion-safe:animate-pulse";
  return (
    <span data-github-status={check.status} aria-live="polite" className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {check.status === "checking" ? "Checking" : null}
      {check.status === "connected" ? <span className="truncate">Connected <span className="text-foreground">{check.login}</span></span> : null}
      {check.status === "failed" ? <span className="truncate text-destructive">{check.error}</span> : null}
    </span>
  );
}

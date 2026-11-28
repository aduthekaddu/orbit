"use client";

import { useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { appliedSave, type SettingsSnapshot } from "@/lib/settings-form";
import type { PublicUserGithub } from "@/lib/user-github";
import { cn } from "@/lib/utils";
import { Row } from "./row";
import { SaveNotice } from "./save-notice";
import { useSettingsSave } from "./use-settings-save";

const savedBody = z.object({ githubTokenSet: z.boolean(), githubTokenReadable: z.boolean(), githubMcpUrl: z.string() });
const githubCheckBody = z.object({ ok: z.boolean(), login: z.string().optional(), error: z.string().optional() });
const GITHUB_UNAVAILABLE = "GitHub is unavailable.";

type GithubCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; login: string }
  | { status: "failed"; error: string };

export function SettingsForm({ initial }: { initial: PublicUserGithub }) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState<SettingsSnapshot>({ url: initial.githubMcpUrl, secret: "" });
  const [check, setCheck] = useState<GithubCheck>({ status: "idle" });
  const current = useRef(form);
  const latestGithubCheck = useLatestRequest();
  const submit = useSettingsSave("/api/settings", "PUT", savedBody);
  const tokenSet = saved.githubTokenSet && form.secret !== null;
  const unreadable = tokenSet && !saved.githubTokenReadable;

  function setFields(fields: SettingsSnapshot) {
    current.current = fields;
    setForm(fields);
  }

  function edit(patch: Partial<SettingsSnapshot>) {
    if (check.status === "checking") latestGithubCheck();
    setCheck({ status: "idle" });
    submit.edit();
    setFields({ ...current.current, ...patch });
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit.save({
      githubMcpUrl: form.url.trim(),
      githubToken: form.secret === null ? null : form.secret || undefined,
    }, (body) => {
      const applied = appliedSave(form, current.current);
      setSaved(body);
      setFields({
        url: current.current.url === form.url ? body.githubMcpUrl : current.current.url,
        secret: applied.clearSecret ? "" : current.current.secret,
      });
      return applied.saved;
    });
  }

  function onCheckGithub() {
    setCheck({ status: "checking" });
    void requestJson(
      "/api/settings/github/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: latestGithubCheck(),
        body: JSON.stringify({ token: form.secret?.trim() || undefined, mcpUrl: form.url.trim() }),
      },
      {
        parse: githubCheckBody,
        onOk: (body) =>
          setCheck(body.ok && body.login ? { status: "connected", login: body.login } : { status: "failed", error: body.error || GITHUB_UNAVAILABLE }),
        onFailed: (failure) => setCheck({ status: "failed", error: (failure.kind === "http" && failure.error) || GITHUB_UNAVAILABLE }),
      },
    );
  }

  return (
    <form id="github" aria-labelledby="github-heading" onSubmit={onSubmit} className="min-w-0 scroll-mt-6 rounded-xl border bg-card shadow-card">
      <div className="border-b px-5 py-3.5">
        <h2 id="github-heading" className="text-sm font-medium">GitHub</h2>
      </div>
      <div className="divide-y">
        <Row id="githubToken" label="Token">
          <div className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <Input id="githubToken" type="password" value={form.secret ?? ""} placeholder={tokenSet && !unreadable ? "Token set" : ""} autoComplete="off" onChange={(event) => edit({ secret: event.target.value })} />
              {tokenSet ? (
                <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-touch" aria-label="Remove GitHub token" disabled={submit.pending} onClick={() => edit({ secret: null })}>
                  Remove
                </Button>
              ) : null}
            </div>
            {unreadable ? <p className="text-meta text-destructive">Token unreadable</p> : null}
          </div>
        </Row>
        <Row id="githubMcpUrl" label="MCP URL">
          <Input id="githubMcpUrl" value={form.url} autoComplete="off" onChange={(event) => edit({ url: event.target.value })} />
        </Row>
      </div>
      <div className="border-t px-5 py-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="max-sm:min-h-touch" disabled={submit.pending || form.secret === null || check.status === "checking"} onClick={onCheckGithub}>
            Check
          </Button>
          <div className="ml-auto min-w-0"><SaveNotice state={submit.state} /></div>
          <Button type="submit" size="sm" className="max-sm:min-h-touch" disabled={submit.pending}>Save</Button>
        </div>
        <GithubCheckStatus check={check} />
      </div>
    </form>
  );
}

function GithubCheckStatus({ check }: { check: GithubCheck }) {
  if (check.status === "idle") return null;
  const dot = check.status === "connected" ? "bg-positive" : check.status === "failed" ? "bg-destructive" : "bg-warning motion-safe:animate-pulse";
  return (
    <div data-github-status={check.status} role="status" className="mt-2 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {check.status === "checking" ? "Checking" : null}
      {check.status === "connected" ? <span className="min-w-0 wrap-anywhere">Connected <span className="text-foreground">{check.login}</span></span> : null}
      {check.status === "failed" ? <span className="min-w-0 wrap-anywhere text-destructive">{check.error}</span> : null}
    </div>
  );
}

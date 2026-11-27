"use client";

import { useRef, useState } from "react";
import { z } from "zod";
import { Row } from "@/components/settings/row";
import { SaveNotice } from "@/components/settings/save-notice";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { PublicInstanceSettings } from "@/lib/instance-settings";
import { appliedSave, type SettingsSnapshot } from "@/lib/settings-form";
import { HostingSettings, InviteSettings, UserSettings } from "./account-settings";

const url = "/api/admin/settings";
const searchBody = z.object({ searxngUrl: z.string(), tavilyKeySet: z.boolean(), tavilyKeyReadable: z.boolean() });
const sandboxBody = z.object({ sandbox: z.boolean() });
const dreamBody = z.object({ dreamHour: z.number().int().min(0).max(23) });
const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);

export function AdminForm({ initial }: { initial: PublicInstanceSettings }) {
  const [mode, setMode] = useState({ hostingMode: initial.hostingMode, signupMode: initial.signupMode });

  return (
    <>
      <HostingSettings mode={mode} onSaved={setMode} />
      {mode.hostingMode === "personal" ? null : <InviteSettings key={mode.hostingMode} />}
      <UserSettings />
      <SearchSettings initial={initial} />
      <SandboxSettings available={initial.sandboxAvailable} initial={initial.sandbox} />
      <DreamSettings initial={initial.dreamHour} />
    </>
  );
}

function SearchSettings({ initial }: { initial: Pick<PublicInstanceSettings, "searxngUrl" | "tavilyKeySet" | "tavilyKeyReadable"> }) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState<SettingsSnapshot>({ url: initial.searxngUrl, secret: "" });
  const current = useRef(form);
  const submit = useSettingsSave(url, "PUT", searchBody);
  const keySet = saved.tavilyKeySet && form.secret !== null;
  const unreadable = keySet && !saved.tavilyKeyReadable;

  function setFields(fields: SettingsSnapshot) {
    current.current = fields;
    setForm(fields);
  }

  function edit(patch: Partial<SettingsSnapshot>) {
    submit.edit();
    setFields({ ...current.current, ...patch });
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit.save({
      searxngUrl: form.url.trim(),
      tavilyApiKey: form.secret === null ? null : form.secret || undefined,
    }, (body) => {
      const applied = appliedSave(form, current.current);
      setSaved(body);
      setFields({
        url: current.current.url === form.url ? body.searxngUrl : current.current.url,
        secret: applied.clearSecret ? "" : current.current.secret,
      });
      return applied.saved;
    });
  }

  return (
    <form aria-labelledby="search-heading" onSubmit={onSubmit} className="min-w-0 rounded-xl border bg-card shadow-card">
      <div className="border-b px-5 py-3.5">
        <h2 id="search-heading" className="text-sm font-medium">Search</h2>
      </div>
      <div className="divide-y">
        <Row id="searxngUrl" label="SearXNG URL">
          <Input id="searxngUrl" value={form.url} autoComplete="off" onChange={(event) => edit({ url: event.target.value })} />
        </Row>
        <Row id="tavilyApiKey" label="Tavily key">
          <div className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <Input id="tavilyApiKey" type="password" value={form.secret ?? ""} placeholder={keySet && !unreadable ? "Key set" : ""} autoComplete="off" onChange={(event) => edit({ secret: event.target.value })} />
              {keySet ? (
                <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-touch" aria-label="Remove Tavily key" disabled={submit.pending} onClick={() => edit({ secret: null })}>
                  Remove
                </Button>
              ) : null}
            </div>
            {unreadable ? <p className="text-meta text-destructive">Key unreadable</p> : null}
          </div>
        </Row>
      </div>
      <div className="flex items-center justify-end gap-3 border-t px-5 py-3">
        <SaveNotice state={submit.state} />
        <Button type="submit" size="sm" className="max-sm:min-h-touch" disabled={submit.pending}>Save</Button>
      </div>
    </form>
  );
}

function SandboxSettings({ available, initial }: { available: boolean; initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const submit = useSettingsSave(url, "PUT", sandboxBody);

  return (
    <section aria-labelledby="sandbox-heading" className="rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h2 id="sandbox-heading" className="text-sm font-medium">Code sandbox</h2>
        <div data-sandbox-status={enabled ? "on" : "off"} className="flex items-center gap-3 text-meta text-muted-foreground">
          <span>{enabled ? "On" : "Off"}</span>
          {available ? <Switch
            aria-labelledby="sandbox-heading"
            checked={enabled}
            disabled={submit.pending}
            className="relative before:absolute before:-inset-3"
            onCheckedChange={(checked) => submit.save({ sandbox: checked ? "on" : "off" }, (body) => setEnabled(body.sandbox))}
          /> : null}
        </div>
      </div>
      <SaveNotice state={submit.state} />
    </section>
  );
}

function DreamSettings({ initial }: { initial: number }) {
  const [hour, setHour] = useState(initial);
  const submit = useSettingsSave(url, "PUT", dreamBody);

  return (
    <section aria-labelledby="dream-heading" className="rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h2 id="dream-heading" className="text-sm font-medium">Dreaming</h2>
        <Select value={String(hour)} disabled={submit.pending} onValueChange={(value) => submit.save({ dreamHour: Number(value) }, (body) => setHour(body.dreamHour))}>
          <SelectTrigger aria-label="Hour" className="font-mono max-sm:min-h-touch"><SelectValue /></SelectTrigger>
          <SelectContent align="end">
            {hours.map((label, index) => <SelectItem key={label} value={String(index)} className="font-mono max-sm:min-h-touch">{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <SaveNotice state={submit.state} />
    </section>
  );
}

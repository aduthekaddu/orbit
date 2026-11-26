"use client";

import { useId, useReducer, useState } from "react";
import { PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectionKind, PublicConnection } from "@/lib/connections";
import { publicConnectionBody } from "@/lib/model-picker";
import { requestJson, type RequestFailure } from "@/lib/request-json";
import { idleSubmit, submitTransition } from "@/lib/submit-state";

export const KIND_LABELS: Record<ConnectionKind, string> = {
  "openai-compatible": "OpenAI-compatible",
  anthropic: "Anthropic",
};

const KINDS = Object.keys(KIND_LABELS) as ConnectionKind[];
const deletedBody = z.object({ ok: z.literal(true) });

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function failureText(failure: RequestFailure) {
  return (failure.kind === "http" && failure.error) || "Could not save.";
}

type Open = { kind: "closed" } | { kind: "add" } | { kind: "edit"; connection: PublicConnection } | { kind: "delete"; connection: PublicConnection };

export function ConnectionSettings({
  connections,
  onAdded,
  onUpdated,
  onDeleted,
}: {
  connections: PublicConnection[];
  onAdded: (connection: PublicConnection) => void;
  onUpdated: (connection: PublicConnection) => void;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState<Open>({ kind: "closed" });
  const close = () => setOpen({ kind: "closed" });
  return (
    <section aria-labelledby="connections-heading" className="rounded-xl border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-2.5">
        <h2 id="connections-heading" className="text-sm font-medium">
          Connections
        </h2>
        <Button variant="outline" size="xs" onClick={() => setOpen({ kind: "add" })}>
          <PlusIcon weight="regular" />
          Add
        </Button>
      </div>
      <ul className="divide-y">
        {connections.map((connection) => (
          <li key={connection.id} data-connection-row={connection.id} className="flex items-center gap-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{connection.label}</p>
              <p className="text-meta wrap-anywhere text-muted-foreground">
                {KIND_LABELS[connection.kind]}
                {connection.kind === "openai-compatible" ? ` · ${hostOf(connection.baseUrl)}` : null}
              </p>
            </div>
            <Button variant="ghost" size="xs" aria-label={`Edit ${connection.label}`} onClick={() => setOpen({ kind: "edit", connection })}>
              Edit
            </Button>
            <Button variant="ghost" size="xs" aria-label={`Delete ${connection.label}`} onClick={() => setOpen({ kind: "delete", connection })}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={open.kind !== "closed"} onOpenChange={(next) => (next ? undefined : close())}>
        {open.kind === "add" ? (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Add connection</DialogTitle>
            </DialogHeader>
            <ConnectionForm
              onCancel={close}
              onSaved={(connection) => {
                close();
                onAdded(connection);
              }}
            />
          </DialogContent>
        ) : open.kind === "edit" ? (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Edit connection</DialogTitle>
            </DialogHeader>
            <ConnectionForm
              editing={open.connection}
              onCancel={close}
              onSaved={(connection) => {
                close();
                onUpdated(connection);
              }}
            />
          </DialogContent>
        ) : open.kind === "delete" ? (
          <DeleteConnection
            connection={open.connection}
            onCancel={close}
            onDeleted={() => {
              close();
              onDeleted(open.connection.id);
            }}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

function DeleteConnection({ connection, onCancel, onDeleted }: { connection: PublicConnection; onCancel: () => void; onDeleted: () => void }) {
  const [state, dispatch] = useReducer(submitTransition, idleSubmit);
  const pending = state.status === "pending";
  function remove() {
    if (pending) return;
    dispatch({ type: "submit" });
    void requestJson(`/api/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" }, {
      parse: deletedBody,
      onOk: () => {
        dispatch({ type: "succeed" });
        onDeleted();
      },
      onFailed: (failure) => dispatch({ type: "fail", error: (failure.kind === "http" && failure.error) || "Could not delete." }),
    });
  }
  return (
    <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle className="leading-snug break-words">Delete {connection.label}?</DialogTitle>
      </DialogHeader>
      {state.status === "failed" ? <FormError error={state.error} /> : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={pending} onClick={remove}>
          Delete
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function FormError({ error }: { error: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-meta text-destructive">
      <WarningCircleIcon weight="regular" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{error}</span>
    </p>
  );
}

/** Adds a connection (kind first, then its fields) or edits one. A blank key on edit keeps the saved key. */
export function ConnectionForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing?: PublicConnection;
  onSaved: (connection: PublicConnection) => void;
  onCancel?: () => void;
}) {
  const ids = useId();
  const [kind, setKind] = useState<ConnectionKind | null>(editing?.kind ?? null);
  const [label, setLabel] = useState(editing?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.kind === "openai-compatible" ? editing.baseUrl : "");
  const [apiKey, setApiKey] = useState("");
  const [state, dispatch] = useReducer(submitTransition, idleSubmit);
  const pending = state.status === "pending";

  if (!kind) {
    return (
      <div className="flex flex-col gap-4">
        <div role="group" aria-label="Kind" className="grid gap-2 sm:grid-cols-2">
          {KINDS.map((option) => (
            <button
              key={option}
              type="button"
              data-connection-kind={option}
              onClick={() => {
                setKind(option);
                if (option === "anthropic" && !label) setLabel(KIND_LABELS.anthropic);
              }}
              className="cursor-pointer rounded-lg border bg-surface-sunken px-4 py-3 text-left text-sm transition-colors duration-150 ease-orbit outline-none hover:border-border-strong hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {KIND_LABELS[option]}
            </button>
          ))}
        </div>
        {onCancel ? (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  function body() {
    const named = label.trim();
    if (!editing) {
      const fallback = kind === "openai-compatible" ? hostOf(baseUrl.trim()) : KIND_LABELS.anthropic;
      const fields = { label: named || fallback, apiKey: apiKey.trim() };
      return kind === "openai-compatible" ? { kind, ...fields, baseUrl: baseUrl.trim() } : { kind, ...fields };
    }
    return {
      label: named && named !== editing.label ? named : undefined,
      baseUrl: editing.kind === "openai-compatible" && baseUrl.trim() !== editing.baseUrl ? baseUrl.trim() : undefined,
      apiKey: apiKey.trim() || undefined,
    };
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    dispatch({ type: "submit" });
    const url = editing ? `/api/connections/${encodeURIComponent(editing.id)}` : "/api/connections";
    void requestJson(url, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) }, {
      parse: publicConnectionBody,
      onOk: (connection) => {
        dispatch({ type: "succeed" });
        onSaved(connection);
      },
      onFailed: (failure) => dispatch({ type: "fail", error: failureText(failure) }),
    });
  }

  const edit = () => dispatch({ type: "edit" });

  return (
    <form onSubmit={submit} data-connection-form={kind} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-label`} className="text-meta text-muted-foreground">
          Label
        </Label>
        <Input id={`${ids}-label`} value={label} maxLength={100} autoComplete="off" onChange={(event) => { edit(); setLabel(event.target.value); }} />
      </div>
      {kind === "openai-compatible" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-base-url`} className="text-meta text-muted-foreground">
            Base URL
          </Label>
          <Input id={`${ids}-base-url`} type="url" inputMode="url" required value={baseUrl} maxLength={2048} autoComplete="off" onChange={(event) => { edit(); setBaseUrl(event.target.value); }} />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-api-key`} className="text-meta text-muted-foreground">
          API key
        </Label>
        <Input
          id={`${ids}-api-key`}
          type="password"
          required={!editing}
          value={apiKey}
          maxLength={4096}
          placeholder={editing ? "Key set" : ""}
          autoComplete="off"
          onChange={(event) => { edit(); setApiKey(event.target.value); }}
        />
      </div>
      {state.status === "failed" ? <FormError error={state.error} /> : null}
      <div className="flex items-center justify-end gap-2">
        {!editing ? (
          <Button type="button" variant="ghost" className="mr-auto" disabled={pending} onClick={() => { edit(); setKind(null); }}>
            Back
          </Button>
        ) : null}
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={pending}>
          {editing ? "Save" : "Add"}
        </Button>
      </div>
    </form>
  );
}

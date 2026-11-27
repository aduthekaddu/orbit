"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { z } from "zod";
import { useCopy } from "@/components/chat/use-copy";
import { SaveNotice } from "@/components/settings/save-notice";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicInstanceSettings } from "@/lib/instance-settings";
import { requestJson, useLatestRequest, useLoaded, type RequestFailure } from "@/lib/request-json";
import { idleSubmit, submitTransition } from "@/lib/submit-state";

const modeBody = z.object({
  hostingMode: z.enum(["personal", "team", "community"]),
  signupMode: z.enum(["invite", "open"]),
});
const invite = z.object({ id: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() });
const inviteList = z.object({ invites: z.array(invite) });
const inviteCreated = invite.extend({ link: z.url() });
const account = z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.enum(["admin", "member"]), createdAt: z.iso.datetime() });
const accountList = z.object({ users: z.array(account) });
const deleted = z.object({ ok: z.literal(true) });

const invitesUrl = "/api/admin/invites";
const usersUrl = "/api/admin/users";
const card = "min-w-0 rounded-xl border bg-card shadow-card";
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const expiryDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function requestError(failure: RequestFailure, fallback: string) {
  return (failure.kind === "http" && failure.error) || fallback;
}

export function HostingSettings({
  mode,
  onSaved,
}: {
  mode: Pick<PublicInstanceSettings, "hostingMode" | "signupMode">;
  onSaved: (mode: z.infer<typeof modeBody>) => void;
}) {
  const submit = useSettingsSave("/api/admin/settings", "PUT", modeBody);

  return (
    <section aria-labelledby="hosting-heading" className={card}>
      <div className="flex min-w-0 items-center justify-between gap-4 px-5 py-3.5">
        <h2 id="hosting-heading" className="text-sm font-medium">Hosting</h2>
        <Select value={mode.hostingMode} disabled={submit.pending} onValueChange={(hostingMode) => submit.save({ hostingMode }, onSaved)}>
          <SelectTrigger aria-label="Hosting mode" className="w-35 pointer-coarse:min-h-touch"><SelectValue /></SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="personal" className="pointer-coarse:min-h-touch">Personal</SelectItem>
            <SelectItem value="team" className="pointer-coarse:min-h-touch">Team</SelectItem>
            <SelectItem value="community" className="pointer-coarse:min-h-touch">Community</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode.hostingMode === "community" ? (
        <div className="flex min-w-0 items-center justify-between gap-4 border-t px-5 py-3.5">
          <h2 className="text-sm font-medium">Signup</h2>
          <Select value={mode.signupMode} disabled={submit.pending} onValueChange={(signupMode) => submit.save({ signupMode }, onSaved)}>
            <SelectTrigger aria-label="Signup mode" className="w-35 pointer-coarse:min-h-touch"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="invite" className="pointer-coarse:min-h-touch">Invite only</SelectItem>
              <SelectItem value="open" className="pointer-coarse:min-h-touch">Open</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {submit.state.status === "succeeded" || submit.state.status === "failed" ? (
        <div className="border-t px-5 py-2"><SaveNotice state={submit.state} /></div>
      ) : null}
    </section>
  );
}

export function InviteSettings() {
  const [list, load, , replace] = useLoaded<z.infer<typeof inviteList>>({ status: "pending" });
  const [newLink, setNewLink] = useState<{ id: string; link: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changing = useRef(false);
  const latest = useLatestRequest();

  useEffect(() => load(invitesUrl, {}, inviteList), [load]);

  function start() {
    if (changing.current) return false;
    changing.current = true;
    setPending(true);
    setError("");
    return true;
  }

  function finish() {
    changing.current = false;
    setPending(false);
  }

  function create() {
    if (list.status !== "done" || !start()) return;
    void requestJson(invitesUrl, { method: "POST", signal: latest() }, {
      parse: inviteCreated,
      onOk: ({ link, ...created }) => {
        replace({ status: "done", data: { invites: [created, ...list.data.invites] } });
        setNewLink({ id: created.id, link });
        finish();
      },
      onFailed: (failure) => {
        setError(requestError(failure, "Could not create invite."));
        finish();
      },
    });
  }

  function revoke(id: string) {
    if (list.status !== "done" || !start()) return;
    void requestJson(`${invitesUrl}/${encodeURIComponent(id)}`, { method: "DELETE", signal: latest() }, {
      parse: deleted,
      onOk: () => {
        replace({ status: "done", data: { invites: list.data.invites.filter((item) => item.id !== id) } });
        setNewLink((current) => current?.id === id ? null : current);
        finish();
      },
      onFailed: (failure) => {
        setError(requestError(failure, "Could not revoke invite."));
        finish();
      },
    });
  }

  return (
    <section aria-labelledby="invites-heading" className={card} aria-busy={list.status === "pending" || pending}>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-2.5">
        <h2 id="invites-heading" className="text-sm font-medium">Invites</h2>
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-touch" disabled={pending || list.status !== "done"} onClick={create}>
          Create invite
        </Button>
      </div>
      {newLink ? <InviteLink key={newLink.id} link={newLink.link} /> : null}
      {list.status === "pending" ? <Skeleton aria-label="Loading invites" role="status" className="m-5 h-4 w-32" /> : null}
      {list.status === "failed" ? (
        <LoadError error={requestError(list.failure, "Could not load invites.")} retry={() => load(invitesUrl, {}, inviteList)} />
      ) : null}
      {list.status === "done" && list.data.invites.length === 0 ? <p className="px-5 py-3.5 text-sm text-muted-foreground">No pending invites</p> : null}
      {list.status === "done" && list.data.invites.length > 0 ? (
        <ul className="divide-y">
          {list.data.invites.map(({ id, expiresAt }) => (
            <li key={id} className="flex min-w-0 items-center justify-between gap-3 px-5 py-2.5">
              <p className="min-w-0 text-sm wrap-anywhere">
                Expires <time dateTime={expiresAt}>{expiryDate.format(new Date(expiresAt))}</time>
              </p>
              <Button variant="ghost" size="sm" className="shrink-0 pointer-coarse:min-h-touch" disabled={pending} onClick={() => revoke(id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="border-t px-5 py-3 text-meta wrap-anywhere text-destructive">{error}</p> : null}
    </section>
  );
}

function InviteLink({ link }: { link: string }) {
  const { copied, failed, copy } = useCopy();

  return (
    <div className="border-b bg-surface-sunken px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <Input aria-label="Invite link" data-evidence-redact readOnly value={link} className="min-w-0 bg-card font-mono pointer-coarse:min-h-touch" onFocus={(event) => event.target.select()} />
        <Button variant="outline" size="sm" className="shrink-0 pointer-coarse:min-h-touch" onClick={() => copy(link)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {copied ? <span role="status" className="sr-only">Link copied</span> : null}
      {failed ? <p role="alert" className="mt-2 text-meta text-destructive">Could not copy link.</p> : null}
    </div>
  );
}

function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-5 py-3">
      <p role="alert" className="min-w-0 text-meta wrap-anywhere text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="pointer-coarse:min-h-touch" onClick={retry}>Retry</Button>
    </div>
  );
}

export function UserSettings() {
  const [list, load, , replace] = useLoaded<z.infer<typeof accountList>>({ status: "pending" });

  useEffect(() => load(usersUrl, {}, accountList), [load]);

  return (
    <section aria-labelledby="users-heading" className={card} aria-busy={list.status === "pending"}>
      <div className="border-b px-5 py-3.5"><h2 id="users-heading" className="text-sm font-medium">Users</h2></div>
      {list.status === "pending" ? <Skeleton aria-label="Loading users" role="status" className="m-5 h-4 w-32" /> : null}
      {list.status === "failed" ? (
        <LoadError error={requestError(list.failure, "Could not load users.")} retry={() => load(usersUrl, {}, accountList)} />
      ) : null}
      {list.status === "done" ? (
        <ul className="divide-y">
          {list.data.users.map(({ id, email, role, createdAt }) => (
            <li key={id} className="flex min-w-0 items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p title={email} className="truncate text-sm">{email}</p>
                <time dateTime={createdAt} aria-label="Account created" className="text-meta text-muted-foreground">{date.format(new Date(createdAt))}</time>
              </div>
              {role === "admin" ? <span className="text-meta font-medium text-muted-foreground">Admin</span> : (
                <RemoveUser id={id} email={email} onRemoved={() => replace({ status: "done", data: { users: list.data.users.filter((user) => user.id !== id) } })} />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RemoveUser({ id, email, onRemoved }: { id: string; email: string; onRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(submitTransition, idleSubmit);
  const removing = useRef(false);
  const latest = useLatestRequest();
  const pending = state.status === "pending";

  function changeOpen(next: boolean) {
    if (removing.current) return;
    dispatch({ type: "edit" });
    setOpen(next);
  }

  function remove() {
    if (removing.current) return;
    removing.current = true;
    dispatch({ type: "submit" });
    void requestJson(`${usersUrl}/${encodeURIComponent(id)}`, { method: "DELETE", signal: latest() }, {
      parse: deleted,
      onOk: () => {
        removing.current = false;
        setOpen(false);
        onRemoved();
      },
      onFailed: (failure) => {
        removing.current = false;
        dispatch({ type: "fail", error: requestError(failure, "Could not remove account.") });
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Remove ${email}`} className="shrink-0 text-destructive pointer-coarse:min-h-touch">Remove</Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => { if (removing.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (removing.current) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Remove account</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            <span className="block font-medium text-foreground">{email}</span>
            This deletes the account and its data.
          </DialogDescription>
        </DialogHeader>
        <SaveNotice state={state} />
        <DialogFooter>
          <Button variant="outline" className="pointer-coarse:min-h-touch" disabled={pending} onClick={() => changeOpen(false)}>Cancel</Button>
          <Button variant="destructive" className="pointer-coarse:min-h-touch" disabled={pending} onClick={remove}>Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

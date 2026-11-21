"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { memoryWriteError } from "./save-error";
import { visibleMemories } from "./visible-memories";

type MemoryKind = "fact" | "preference" | "summary";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  text: string;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  sourceTitle: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  embedded: boolean;
};

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  summary: "Summary",
};

function formatWhen(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}

function sourceHref(memory: MemoryItem) {
  if (!memory.sourceChatId) return null;
  const message = memory.sourceMessageId ? `?m=${encodeURIComponent(memory.sourceMessageId)}` : "";
  return `/c/${memory.sourceChatId}${message}`;
}

export function MemoryList({
  initial,
  embeddings,
  dreamStatus = null,
}: {
  initial: MemoryItem[];
  embeddings: { ok: true } | { ok: false; error: string };
  dreamStatus?: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [fetched, setFetched] = useState<{ query: string; rows: MemoryItem[] } | null>(null);
  const [status, setStatus] = useState(embeddings);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);

  useEffect(() => {
    setStatus(embeddings);
  }, [embeddings]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/memories?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { memories?: MemoryItem[]; embeddings?: { ok: true } | { ok: false; error: string } } | null) => {
          if (controller.signal.aborted) return;
          if (!payload || !Array.isArray(payload.memories)) {
            setFetched({ query: trimmed, rows: [] });
            setError("Could not search");
            return;
          }
          setFetched({ query: trimmed, rows: payload.memories });
          setError((current) => (current === "Could not search" ? "" : current));
          if (payload.embeddings) setStatus(payload.embeddings);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setFetched({ query: trimmed, rows: [] });
          setError("Could not search");
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, initial]);

  async function save(id: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft, kind }),
      });
      if (!response.ok) {
        setError(memoryWriteError(await response.json().catch(() => null)));
        return;
      }
      setEditing(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function remove(id: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setError("Could not delete");
        return;
      }
      setPendingDelete(null);
      setEditing(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const visible = visibleMemories(query, initial, fetched);

  return (
    <div className="mx-auto w-full max-w-widget px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Memory</h1>
      {dreamStatus ? <p className="mb-4 text-sm text-muted-foreground num">{dreamStatus}</p> : null}
      <p className={status.ok ? "mb-4 text-sm text-positive" : "mb-4 text-sm text-destructive"}>{status.ok ? "Embeddings on" : status.error}</p>
      <Input aria-label="Search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="mb-4" />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <ul className="flex flex-col gap-3">
        {visible.map((memory) => {
          const href = sourceHref(memory);
          const open = editing === memory.id;
          return (
            <li key={memory.id} className="rounded-xl border bg-card p-4 shadow-card">
              {open ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(memory.id);
                  }}
                >
                  <textarea
                    aria-label="Memory"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-input bg-surface-sunken px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
                  />
                  <select
                    aria-label="Kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as MemoryKind)}
                    className="h-9 rounded-md border border-input bg-surface-sunken px-3 text-sm"
                  >
                    {Object.entries(KIND_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>
                      Save
                    </Button>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-2xs font-medium text-muted-foreground">{KIND_LABEL[memory.kind]}</span>
                    <span className="num text-2xs text-muted-foreground">{memory.lastUsedAt ? `Used ${formatWhen(memory.lastUsedAt)}` : formatWhen(memory.createdAt)}</span>
                  </div>
                  <p className="break-words text-sm text-foreground">{memory.text}</p>
                  <div className="flex items-center justify-between gap-3">
                    {href ? (
                      <Link href={href} className="truncate text-sm text-foreground underline decoration-sun underline-offset-4">
                        {memory.sourceTitle || "Chat"}
                      </Link>
                    ) : (
                      <span />
                    )}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(memory.id);
                          setDraft(memory.text);
                          setKind(memory.kind);
                          setError("");
                        }}
                      >
                        Edit
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setPendingDelete(memory)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this memory?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={pending} onClick={() => pendingDelete && void remove(pendingDelete.id)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

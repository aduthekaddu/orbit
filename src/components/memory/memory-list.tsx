"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { memoryWriteError } from "./save-error";
import { isMemorySearchPending, visibleMemories } from "./visible-memories";
import { requestJson, useLoaded } from "@/lib/request-json";

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

const memoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "preference", "summary"]),
  text: z.string(),
  sourceChatId: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  embedded: z.boolean(),
});

function memorySearchBody(query: string) {
  return z.object({ memories: z.array(memoryItemSchema) }).transform((body) => ({ query, rows: body.memories }));
}

const savedMemory = z.object({ memory: memoryItemSchema });
const deletedMemory = z.object({ id: z.string() });

function formatWhen(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}

function subscribeNothing() {
  return () => {};
}

// False on the server and during hydration. The server's time zone is not the reader's, so dates are formatted only in the browser.
function useInBrowser() {
  return useSyncExternalStore(subscribeNothing, () => true, () => false);
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
  const inBrowser = useInBrowser();
  const [query, setQuery] = useState("");
  const [search, loadSearch, reloadSearch, resetSearch] = useLoaded<{ query: string; rows: MemoryItem[] }>({ status: "idle" });
  const requested = useRef("");
  const searchedQuery = useRef("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState<{ id: string; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    searchedQuery.current = trimmed;
    if (!trimmed) {
      requested.current = "";
      resetSearch();
      return;
    }
    resetSearch({ status: "pending" });
    const timer = window.setTimeout(() => {
      requested.current = trimmed;
      loadSearch(`/api/memories?q=${encodeURIComponent(trimmed)}`, {}, memorySearchBody(trimmed));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, loadSearch, resetSearch]);

  // A finished write makes the filtered view stale, so it reloads the search the user still sees. The query comes from
  // the ref, not this closure, so a query typed while the write was in flight is the one that reloads.
  function refreshSearch() {
    const trimmed = searchedQuery.current;
    if (!trimmed) return;
    reloadSearch(`/api/memories?q=${encodeURIComponent(trimmed)}`, {}, memorySearchBody(trimmed));
  }

  function save(id: string) {
    setPending(true);
    setWriteError(null);
    void requestJson(
      `/api/memories/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft, kind }),
      },
      {
        parse: savedMemory,
        onOk: () => {
          setEditing(null);
          router.refresh();
          setPending(false);
          refreshSearch();
        },
        onFailed: (failure) => {
          setWriteError({ id, text: (failure.kind === "http" && failure.error) || memoryWriteError(null) });
          setPending(false);
        },
      },
    );
  }

  function remove(id: string) {
    setPending(true);
    setWriteError(null);
    void requestJson(`/api/memories/${id}`, { method: "DELETE" }, {
      parse: deletedMemory,
      onOk: () => {
        setEditing(null);
        setPendingDelete(null);
        setPending(false);
        router.refresh();
        refreshSearch();
      },
      onFailed: () => {
        setWriteError({ id, text: "Could not delete" });
        setPendingDelete(null);
        setPending(false);
      },
    });
  }

  const trimmed = query.trim();
  const searchFailed = search.status === "failed" && requested.current === trimmed;
  const fetched = search.status === "done" || search.status === "revalidating" ? search.data : searchFailed ? { query: trimmed, rows: [] } : null;
  const visible = visibleMemories(query, initial, fetched);
  const searching = search.status === "revalidating" || isMemorySearchPending(query, fetched);

  return (
    <div className="mx-auto w-full max-w-page px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Memory</h1>
      {dreamStatus ? <p className="mb-4 text-sm text-muted-foreground num">{dreamStatus}</p> : null}
      <p className={embeddings.ok ? "mb-4 text-sm text-positive" : "mb-4 text-sm text-destructive"}>{embeddings.ok ? "Embeddings on" : embeddings.error}</p>
      <Input
        aria-label="Search"
        placeholder="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mb-4"
      />
      {searchFailed && <p className="mb-3 text-sm text-destructive">Could not search</p>}
      <ul aria-busy={searching} className="flex flex-col gap-3">
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
                    className="w-full rounded-md border border-input bg-surface-sunken px-3 py-2 text-input text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
                  />
                  <select
                    aria-label="Kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as MemoryKind)}
                    className="h-9 rounded-md border border-input bg-surface-sunken px-3 text-input"
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
                    <span className="text-meta font-medium text-muted-foreground">{KIND_LABEL[memory.kind]}</span>
                    <span className="num text-meta text-muted-foreground">
                      {inBrowser && (memory.lastUsedAt ? `Used ${formatWhen(memory.lastUsedAt)}` : formatWhen(memory.createdAt))}
                    </span>
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
                          setWriteError(null);
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
              {writeError?.id === memory.id && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {writeError.text}
                </p>
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { Artifact, ArtifactKind } from "@/lib/artifacts/detect";
import type { ArtifactDetail, ArtifactListItem, ArtifactPage, ArtifactVersionSummary } from "@/lib/artifacts/store";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { Figure } from "@/components/figure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { rememberArtifactCode } from "./artifact-diff";
import { ArtifactList, type ListState } from "./artifact-list";
import { ArtifactPanel, type RenameResult } from "./artifact-panel";
import { versionSummary } from "./artifact-versions";

const WIDE_SCREEN = "(min-width: 1024px)";
const SEARCH_DELAY_MS = 150;

const kind = z.enum(["html", "svg", "react"]);
const language = z.enum(["html", "svg", "jsx", "tsx"]);

const listItem = z.object({
  id: z.string(),
  lineageId: z.string(),
  kind,
  language,
  title: z.string(),
  derivedTitle: z.string(),
  userTitle: z.string().nullable(),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string(),
  key: z.string(),
  versionCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ArtifactListItem>;

const artifactPage = z.object({ items: z.array(listItem), nextCursor: z.string().nullable() }) satisfies z.ZodType<ArtifactPage>;

const artifactDetail = z.object({
  id: z.string(),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string(),
  textOrdinal: z.number(),
  blockIndex: z.number(),
  key: z.string(),
  kind,
  language,
  code: z.string(),
  title: z.string(),
  derivedTitle: z.string(),
  userTitle: z.string().nullable(),
  lineageId: z.string(),
  number: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versions: z.array(versionSummary),
}) satisfies z.ZodType<ArtifactDetail>;

const detailBody = z.object({ artifact: artifactDetail });

type KindFilter = ArtifactKind | "all";
type Filter = { q: string; kind: KindFilter };

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "html", label: "HTML" },
  { value: "svg", label: "SVG" },
  { value: "react", label: "React" },
];

/**
 * The right pane. While another version of the same lineage loads, `previous` keeps the open one on screen, so stepping
 * through versions never flashes. `lineageId` marks the row at once, before the detail arrives. A version loaded
 * before shows at once as `refreshing` while it loads again, since another tab may have edited or renamed it.
 */
type DetailState =
  | { status: "ready"; detail: ArtifactDetail }
  | { status: "refreshing"; detail: ArtifactDetail }
  | { status: "loading"; id: string; lineageId: string | null; previous: ArtifactDetail | null }
  | { status: "failed"; id: string }
  | { status: "missing"; id: string };

/** A phone shows one pane: the list, or the detail an explicit `?id=` asks for. */
type Selection = { detail: DetailState | null; explicit: boolean };

function isFiltered(filter: Filter) {
  return filter.q.trim() !== "" || filter.kind !== "all";
}

function listUrl(filter: Filter, cursor?: string) {
  const params = new URLSearchParams();
  const q = filter.q.trim();
  if (q) params.set("q", q);
  if (filter.kind !== "all") params.set("kind", filter.kind);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return search ? `/api/artifacts?${search}` : "/api/artifacts";
}

function firstPage(page: ArtifactPage): ListState {
  return { status: "done", items: page.items, nextCursor: page.nextCursor, more: "idle" };
}

function selectionFrom(requestedId: string | null, initialDetail: ArtifactDetail | null): Selection {
  if (requestedId !== null) return { detail: initialDetail ? { status: "ready", detail: initialDetail } : { status: "missing", id: requestedId }, explicit: true };
  return { detail: initialDetail ? { status: "ready", detail: initialDetail } : null, explicit: false };
}

/** Whether `state` still waits for the answer to a request for `id`. A newer selection or a refresh replaces it. */
function awaits(state: DetailState | null, id: string) {
  return (state?.status === "loading" && state.id === id) || (state?.status === "refreshing" && state.detail.id === id);
}

function shownDetail(state: DetailState | null) {
  if (state?.status === "ready" || state?.status === "refreshing") return state.detail;
  if (state?.status === "loading") return state.previous;
  return null;
}

function urlWithId(id: string | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("id");
  else url.searchParams.set("id", id);
  return url;
}

/** A rename made here shows on every row and version of the lineage, also in results loaded before it. */
function withRename<T extends { lineageId: string; derivedTitle: string; title: string; userTitle: string | null }>(row: T, renames: ReadonlyMap<string, string | null>): T {
  if (!renames.has(row.lineageId)) return row;
  const userTitle = renames.get(row.lineageId) ?? null;
  return { ...row, userTitle, title: userTitle ?? row.derivedTitle };
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex shrink-0 items-center border-b p-2 lg:hidden">
      <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack} className="pointer-coarse:size-11"><ArrowLeftIcon /></Button>
    </div>
  );
}

function DetailPane({ state, renames, onBack, onRetry, onSelectVersion, onRenamed }: {
  state: DetailState | null;
  renames: ReadonlyMap<string, string | null>;
  onBack: () => void;
  onRetry: (id: string) => void;
  onSelectVersion: (version: ArtifactVersionSummary) => void;
  onRenamed: (result: RenameResult) => void;
}) {
  const shown = shownDetail(state);
  const detail = shown && withRename(shown, renames);
  const artifact = useMemo<Artifact | null>(
    () => (shown ? { key: shown.key, kind: shown.kind, language: shown.language, code: shown.code } : null),
    [shown],
  );
  if (detail && artifact) {
    return (
      <ArtifactPanel
        key={detail.lineageId}
        artifact={artifact}
        stored={detail}
        onSelectVersion={onSelectVersion}
        onRenamed={onRenamed}
        openInChatHref={`/c/${detail.chatId}?m=${encodeURIComponent(detail.messageId)}&artifact=${encodeURIComponent(detail.key)}`}
        onBack={onBack}
      />
    );
  }
  if (state?.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card">
        <BackBar onBack={onBack} />
        <span role="status" className="sr-only">Loading artifact</span>
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  if (state?.status === "failed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card">
        <BackBar onBack={onBack} />
        <div role="alert" className="flex items-center gap-3 p-4 text-sm text-destructive">
          <span className="min-w-0 flex-1">Could not load artifact</span>
          <Button variant="outline" size="sm" onClick={() => onRetry(state.id)} className="pointer-coarse:h-11">Retry</Button>
        </div>
      </div>
    );
  }
  if (state?.status === "missing") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card">
        <BackBar onBack={onBack} />
        <p className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Artifact not found</p>
      </div>
    );
  }
  return null;
}

export function ArtifactLibrary({ initial, requestedId, initialDetail }: {
  initial: ArtifactPage;
  requestedId: string | null;
  initialDetail: ArtifactDetail | null;
}) {
  const [filter, setFilter] = useState<Filter>({ q: "", kind: "all" });
  const [list, setList] = useState<ListState>(() => firstPage(initial));
  const [selection, setSelection] = useState<Selection>(() => selectionFrom(requestedId, initialDetail));
  const [renames, setRenames] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // A refresh, such as the one after a chat delete, sends a new list and detail, and they replace what this page holds.
  const [server, setServer] = useState({ initial, requestedId, initialDetail });
  if (server.initial !== initial || server.requestedId !== requestedId || server.initialDetail !== initialDetail) {
    setServer({ initial, requestedId, initialDetail });
    setSelection(selectionFrom(requestedId, initialDetail));
    setRenames(new Map());
  }
  const latestList = useLatestRequest();
  const latestDetail = useLatestRequest();
  const searchTimer = useRef<number | undefined>(undefined);
  const filterNow = useRef(filter);
  // Versions already loaded, so stepping back and forth between them shows them at once while they load again.
  const details = useRef(new Map<string, ArtifactDetail>());
  // Whether the open detail has its own history entry, which Back then leaves instead of replacing.
  const pushed = useRef(false);

  const remember = useCallback((detail: ArtifactDetail) => {
    details.current.set(detail.id, detail);
    rememberArtifactCode(detail.id, detail.updatedAt, detail.code);
  }, []);

  const loadList = useCallback((next: Filter) => {
    const signal = latestList();
    void requestJson(listUrl(next), { signal }, {
      parse: artifactPage,
      onOk: (page) => setList(firstPage(page)),
      onFailed: () => setList({ status: "failed" }),
    });
  }, [latestList]);

  // The server's first page holds the unfiltered list. A search or a kind filter still open after a refresh runs again.
  // A detail still loading belongs to the page before the refresh, so it is dropped with the versions loaded so far.
  useEffect(() => {
    latestDetail();
    details.current = new Map();
    if (initialDetail) remember(initialDetail);
    if (isFiltered(filterNow.current)) loadList(filterNow.current);
    else {
      latestList();
      setList(firstPage(initial));
    }
  }, [initial, initialDetail, loadList, latestList, latestDetail, remember]);

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  function applyFilter(next: Filter, delay: number) {
    setFilter(next);
    filterNow.current = next;
    window.clearTimeout(searchTimer.current);
    // An answer still on its way is for the old search, so it is dropped now, not when the next request goes out.
    latestList();
    if (!isFiltered(next)) {
      setList(firstPage(initial));
      return;
    }
    // Pending from the first keystroke, so the old results never read as the answer to the new query.
    setList((current) => ({ status: "loading", previous: current.status === "done" ? current.items : current.status === "loading" ? current.previous : [] }));
    searchTimer.current = window.setTimeout(() => loadList(next), delay);
  }

  function showMore() {
    if (list.status !== "done" || list.nextCursor === null) return;
    const signal = latestList();
    setList({ ...list, more: "loading" });
    void requestJson(listUrl(filterNow.current, list.nextCursor), { signal }, {
      parse: artifactPage,
      onOk: (page) => setList((current) => {
        if (current.status !== "done") return current;
        const seen = new Set(current.items.map((item) => item.lineageId));
        return { status: "done", items: [...current.items, ...page.items.filter((item) => !seen.has(item.lineageId))], nextCursor: page.nextCursor, more: "idle" };
      }),
      onFailed: () => setList((current) => (current.status === "done" ? { ...current, more: "failed" } : current)),
    });
  }

  const showDetail = useCallback((id: string, explicit: boolean, lineageId: string | null) => {
    const known = details.current.get(id);
    setSelection((current) => {
      if (known) return { detail: { status: "refreshing", detail: known }, explicit };
      const shown = shownDetail(current.detail);
      const previous = shown && lineageId !== null && shown.lineageId === lineageId ? shown : null;
      return { detail: { status: "loading", id, lineageId, previous }, explicit };
    });
    const signal = latestDetail();
    void requestJson(`/api/artifacts/${encodeURIComponent(id)}`, { signal }, {
      parse: detailBody,
      onOk: ({ artifact }) => {
        remember(artifact);
        setSelection((current) => {
          if (!awaits(current.detail, id)) return current;
          // An unchanged answer keeps the shown object, so the panel does not render again.
          const shown = shownDetail(current.detail);
          const detail = shown && JSON.stringify(shown) === JSON.stringify(artifact) ? shown : artifact;
          return { ...current, detail: { status: "ready", detail } };
        });
      },
      onFailed: (failure) => setSelection((current) => (awaits(current.detail, id) ? {
        ...current,
        detail: failure.kind === "http" && failure.status === 404 ? { status: "missing", id } : { status: "failed", id },
      } : current)),
    });
  }, [latestDetail, remember]);

  // Browser Back and Forward move between the list and a detail the page pushed.
  useEffect(() => {
    function onPopState() {
      const id = new URL(window.location.href).searchParams.get("id");
      if (id === null) {
        pushed.current = false;
        setSelection((current) => ({ ...current, explicit: false }));
      } else {
        showDetail(id, true, null);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showDetail]);

  function openRow(item: ArtifactListItem) {
    if (window.matchMedia(WIDE_SCREEN).matches) window.history.replaceState(null, "", urlWithId(item.id));
    else {
      window.history.pushState(null, "", urlWithId(item.id));
      pushed.current = true;
    }
    showDetail(item.id, true, item.lineageId);
  }

  function selectVersion(version: ArtifactVersionSummary) {
    window.history.replaceState(null, "", urlWithId(version.id));
    showDetail(version.id, true, shownDetail(selection.detail)?.lineageId ?? null);
  }

  function back() {
    if (pushed.current) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", urlWithId(null));
    setSelection((current) => ({ ...current, explicit: false }));
  }

  function renamed(result: RenameResult) {
    setRenames((current) => new Map(current).set(result.lineageId, result.userTitle));
  }

  const filtered = isFiltered(filter);
  const listed = useMemo<ListState>(() => {
    if (renames.size === 0) return list;
    if (list.status === "done") return { ...list, items: list.items.map((item) => withRename(item, renames)) };
    if (list.status === "loading") return { ...list, previous: list.previous.map((item) => withRename(item, renames)) };
    return list;
  }, [list, renames]);
  const selectedLineageId = selection.detail?.status === "loading" ? selection.detail.lineageId : shownDetail(selection.detail)?.lineageId ?? null;

  if (list.status === "done" && list.items.length === 0 && !filtered && !selection.explicit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[8vh] scrollbar-thin">
        <h1 className="sr-only">Artifacts</h1>
        <div className="w-40 animate-rise">
          <Figure name="stack" />
        </div>
        <p className="mt-6 text-sm text-muted-foreground">No artifacts</p>
      </div>
    );
  }

  const view = selection.explicit ? "detail" : "list";
  return (
    <div data-view={view} className="flex h-full min-h-0 min-w-0 flex-1">
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col lg:w-80 lg:flex-none lg:shrink-0 lg:border-r", view === "detail" && "max-lg:hidden")}>
        <div className="flex shrink-0 flex-col gap-3 px-3 pt-4 pb-3">
          <h1 className="px-1 text-xl font-semibold tracking-tight max-md:hidden">Artifacts</h1>
          <Input
            type="search"
            aria-label="Search artifacts"
            placeholder="Search"
            value={filter.q}
            onChange={(event) => applyFilter({ ...filter, q: event.target.value }, SEARCH_DELAY_MS)}
          />
          <ToggleGroup
            type="single"
            variant="pill"
            size="sm"
            aria-label="Kind"
            value={filter.kind}
            // Radix's single ToggleGroup sends "" when the chosen pill is pressed again.
            onValueChange={(value) => { if (value) applyFilter({ ...filter, kind: value as KindFilter }, 0); }}
          >
            {KIND_FILTERS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} className="px-3 pointer-coarse:h-11 pointer-coarse:min-w-11">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <ScrollFade axis="y" fade="var(--background)" className="flex min-h-0 flex-1 flex-col" scrollerClassName="min-h-0 flex-1 pb-3">
          <ArtifactList
            list={listed}
            filtered={filtered}
            selectedLineageId={selectedLineageId}
            onOpen={openRow}
            onRetry={() => applyFilter(filterNow.current, 0)}
            onShowMore={showMore}
          />
        </ScrollFade>
      </div>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view === "list" && "max-lg:hidden")}>
        <DetailPane
          state={selection.detail}
          renames={renames}
          onBack={back}
          onRetry={(id) => showDetail(id, selection.explicit, null)}
          onSelectVersion={selectVersion}
          onRenamed={renamed}
        />
      </div>
    </div>
  );
}

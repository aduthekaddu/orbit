"use client";

import { useSyncExternalStore, type MouseEvent } from "react";
import type { ArtifactListItem } from "@/lib/artifacts/store";
import { ARTIFACT_KIND_LABEL } from "@/lib/artifacts/title";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { KIND_ICON } from "@/components/chat/artifact-card";
import { chatLabel } from "@/components/chat/chat-row-menu";
import { cn } from "@/lib/utils";

/** The list on screen. Only `done` can say there is nothing, so a pending or failed load never reads as empty. */
export type ListState =
  | { status: "loading"; previous: ArtifactListItem[] }
  | { status: "failed" }
  | { status: "done"; items: ArtifactListItem[]; nextCursor: string | null; more: "idle" | "loading" | "failed" };

function subscribeNothing() {
  return () => {};
}

// False on the server and during hydration. The server's time zone is not the reader's, so dates are formatted only in the browser.
function useInBrowser() {
  return useSyncExternalStore(subscribeNothing, () => true, () => false);
}

function formatDay(value: string) {
  const date = new Date(value);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: thisYear ? undefined : "numeric" }).format(date);
}

function kindLine(item: ArtifactListItem) {
  const kind = ARTIFACT_KIND_LABEL[item.kind];
  return item.versionCount > 1 ? `${kind} · ${item.versionCount} versions` : kind;
}

function plainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function ArtifactRow({ item, selected, inBrowser, onOpen }: { item: ArtifactListItem; selected: boolean; inBrowser: boolean; onOpen: (item: ArtifactListItem) => void }) {
  const KindIcon = KIND_ICON[item.kind];
  return (
    <li>
      {/* A link, so a middle click or a copied address opens this artifact. A plain click opens it in place. */}
      <a
        href={`/artifacts?id=${encodeURIComponent(item.id)}`}
        data-artifact-row={item.lineageId}
        aria-current={selected ? "true" : undefined}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onOpen(item);
        }}
        onKeyDown={(event) => {
          if (event.key !== " ") return;
          event.preventDefault();
          onOpen(item);
        }}
        className={cn(
          "relative flex min-h-touch items-center gap-3 rounded-md px-2.5 py-2 outline-none transition-colors duration-150 ease-orbit focus-visible:ring-[3px] focus-visible:ring-ring/50",
          selected
            ? "bg-accent text-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sun"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-surface-sunken text-muted-foreground">
          <KindIcon weight="light" className="size-[18px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.title}</span>
            <span className="num shrink-0 text-meta text-muted-foreground">{inBrowser ? formatDay(item.updatedAt) : null}</span>
          </span>
          <span className="flex min-w-0 gap-1 text-meta text-muted-foreground">
            <span className="num shrink-0">{kindLine(item)}</span>
            <span aria-hidden className="shrink-0">·</span>
            <span className="min-w-0 truncate">{chatLabel(item.chatTitle)}</span>
          </span>
        </span>
      </a>
    </li>
  );
}

export function ArtifactList({ list, filtered, selectedLineageId, onOpen, onRetry, onShowMore }: {
  list: ListState;
  filtered: boolean;
  selectedLineageId: string | null;
  onOpen: (item: ArtifactListItem) => void;
  onRetry: () => void;
  onShowMore: () => void;
}) {
  const inBrowser = useInBrowser();
  if (list.status === "failed") {
    return (
      <div role="alert" className="flex items-center gap-3 px-3 py-2 text-sm text-destructive">
        <span className="min-w-0 flex-1">Could not load artifacts</span>
        <Button variant="outline" size="sm" onClick={onRetry} className="pointer-coarse:h-11">Retry</Button>
      </div>
    );
  }
  const items = list.status === "done" ? list.items : list.previous;
  if (list.status === "loading" && items.length === 0) {
    return (
      <div aria-busy="true" className="flex flex-col gap-1 px-2.5 py-2">
        <span role="status" className="sr-only">Loading artifacts</span>
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3 py-2">
            <Skeleton className="size-8 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (list.status === "done" && items.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">{filtered ? "No matching artifacts" : "No artifacts"}</p>;
  }
  return (
    <>
      <ul aria-busy={list.status === "loading"} className={cn("flex flex-col gap-px px-1 transition-opacity duration-150 ease-orbit", list.status === "loading" && "opacity-60")}>
        {items.map((item) => (
          <ArtifactRow key={item.lineageId} item={item} selected={item.lineageId === selectedLineageId} inBrowser={inBrowser} onOpen={onOpen} />
        ))}
      </ul>
      {list.status === "done" && list.more === "failed" ? (
        <div role="alert" className="flex items-center gap-3 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1">Could not load artifacts</span>
          <Button variant="outline" size="sm" onClick={onShowMore} className="pointer-coarse:h-11">Retry</Button>
        </div>
      ) : list.status === "done" && list.nextCursor !== null ? (
        <div className="px-1 py-2">
          <Button variant="ghost" size="sm" disabled={list.more === "loading"} onClick={onShowMore} className="w-full text-muted-foreground pointer-coarse:h-11">Show more</Button>
        </div>
      ) : null}
    </>
  );
}

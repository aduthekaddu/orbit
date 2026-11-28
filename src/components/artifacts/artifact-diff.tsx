"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { ArrowRightIcon, CaretUpDownIcon } from "@phosphor-icons/react";
import { diffArtifactLines, type DiffHunk, type DiffLine } from "@/lib/artifacts/diff";
import type { ArtifactVersionSummary } from "@/lib/artifacts/store";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { Button } from "@/components/ui/button";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Saved code of each version, by `${id}:${updatedAt}`, so lists and chat pages stay small and a version edited in
// place loads again.
const savedCode = new Map<string, string>();

function codeKey(id: string, updatedAt: string) {
  return `${id}:${updatedAt}`;
}

/** Keeps code that came from the server, so Diff can compare with that version without loading it. */
export function rememberArtifactCode(id: string, updatedAt: string, code: string) {
  savedCode.set(codeKey(id, updatedAt), code);
}

const versionCode = z.object({ artifact: z.object({ id: z.string(), code: z.string(), updatedAt: z.string() }) });

type BaseLoad = { key: string; code: string | null };

/** The version Diff compares with first: the one before the open version, or the second when the first is open. */
function defaultBase(versions: ArtifactVersionSummary[], currentId: string) {
  const index = versions.findIndex((version) => version.id === currentId);
  return index > 0 ? versions[index - 1] : versions.find((version) => version.id !== currentId);
}

const SIGN: Record<DiffLine["kind"], string> = { context: " ", added: "+", removed: "-" };

function Line({ line }: { line: DiffLine }) {
  return (
    <div
      data-diff-line={line.kind}
      className={cn("flex", line.kind === "added" && "bg-positive/12", line.kind === "removed" && "bg-destructive/12")}
    >
      <span aria-hidden className="num min-w-9 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.beforeLine ?? ""}</span>
      <span aria-hidden className="num min-w-9 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.afterLine ?? ""}</span>
      <span className={cn("w-5 shrink-0 text-center select-none", line.kind === "added" && "text-positive", line.kind === "removed" && "text-destructive")}>{SIGN[line.kind]}</span>
      <span className="pr-4 whitespace-pre">{line.text}</span>
    </div>
  );
}

function DiffHunks({ hunks }: { hunks: DiffHunk[] }) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <ScrollFade axis="x" fade="var(--surface-sunken)" className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken scrollbar-thin">
      <div className="w-max min-w-full py-2 font-mono text-code">
        {hunks.map((hunk, index) => {
          if (hunk.kind === "changes" || opened.has(index)) {
            return hunk.lines.map((line) => <Line key={`${line.beforeLine}:${line.afterLine}`} line={line} />);
          }
          const count = hunk.lines.length;
          return (
            <button
              key={`fold:${index}`}
              type="button"
              aria-expanded={false}
              onClick={() => setOpened((current) => new Set(current).add(index))}
              className="my-1 flex h-7 w-full cursor-pointer items-center gap-2 border-y bg-card px-3 font-sans text-meta text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:h-11"
            >
              <CaretUpDownIcon weight="regular" className="size-3.5" />
              <span><span className="num">{count}</span> unchanged {count === 1 ? "line" : "lines"}</span>
            </button>
          );
        })}
      </div>
    </ScrollFade>
  );
}

/** Compares the open version with another version of its lineage, oldest first, line by line. */
export function ArtifactDiff({ current, versions }: { current: { id: string; code: string }; versions: ArtifactVersionSummary[] }) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<BaseLoad | null>(null);
  const latest = useLatestRequest();
  const base = versions.find((version) => version.id === chosenId && version.id !== current.id) ?? defaultBase(versions, current.id);
  const baseId = base?.id;
  const key = base ? codeKey(base.id, base.updatedAt) : null;

  const load = useCallback(() => {
    if (!baseId || !key) return;
    const signal = latest();
    void requestJson(`/api/artifacts/${encodeURIComponent(baseId)}`, { signal }, {
      parse: versionCode,
      onOk: ({ artifact }) => {
        savedCode.set(codeKey(artifact.id, artifact.updatedAt), artifact.code);
        setLoaded({ key, code: artifact.code });
      },
      onFailed: () => setLoaded({ key, code: null }),
    });
  }, [baseId, key, latest]);

  useEffect(() => {
    if (key && !savedCode.has(key)) load();
  }, [key, load]);

  const cached = key === null ? undefined : savedCode.get(key);
  const fetched = loaded !== null && loaded.key === key ? loaded.code : undefined;
  const baseCode = cached ?? fetched ?? undefined;
  const failed = baseCode === undefined && fetched === null;
  const currentVersion = versions.find((version) => version.id === current.id);
  const baseIsOlder = !base || !currentVersion || base.number < currentVersion.number;
  const diff = useMemo(() => {
    if (baseCode === undefined) return null;
    return baseIsOlder ? diffArtifactLines(baseCode, current.code) : diffArtifactLines(current.code, baseCode);
  }, [baseCode, baseIsOlder, current.code]);

  if (!base) return null;

  const picker = (
    <Select value={base.id} onValueChange={setChosenId}>
      <SelectTrigger size="sm" aria-label="Compare with" className="num pointer-coarse:h-11">
        <SelectValue>{`v${base.number}`}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {versions.filter((version) => version.id !== current.id).map((version) => (
          <SelectItem key={version.id} value={version.id} className="num pointer-coarse:min-h-touch">{`v${version.number}`}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const open = <span className="num px-1 text-sm text-foreground">{currentVersion ? `v${currentVersion.number}` : null}</span>;

  let body;
  if (failed) {
    body = (
      <div role="alert" className="flex items-center gap-3 p-3 text-sm text-destructive">
        <span className="min-w-0 flex-1">Could not load version</span>
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => { setLoaded(null); load(); }}>Retry</Button>
      </div>
    );
  } else if (diff === null) {
    body = (
      <div className="flex flex-col gap-2 p-4">
        <span role="status" className="sr-only">Loading version</span>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (diff.status === "identical") {
    body = <p className="p-4 text-sm text-muted-foreground">No differences</p>;
  } else if (diff.status === "too-large") {
    body = <p className="p-4 text-sm text-muted-foreground">Too large to compare</p>;
  } else {
    body = <DiffHunks key={`${key}|${current.id}`} hunks={diff.hunks} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        {baseIsOlder ? picker : open}
        <ArrowRightIcon aria-hidden weight="regular" className="size-3.5 shrink-0 text-muted-foreground" />
        {baseIsOlder ? open : picker}
        {diff?.status === "ready" ? (
          <span className="ml-auto flex shrink-0 gap-2 pr-1 text-meta">
            <span className="num text-positive">{`+${diff.added}`}</span>
            <span className="num text-destructive">{`-${diff.removed}`}</span>
          </span>
        ) : null}
      </div>
      {body}
    </div>
  );
}

"use client";

import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import type { Artifact } from "@/lib/artifacts/detect";
import type { StoredChatArtifact } from "@/lib/artifacts/store";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { versionSummary } from "./artifact-versions";

type ArtifactContextValue = {
  artifact: Artifact | undefined;
  register: (artifact: Artifact) => () => void;
  open: (key: string) => void;
  close: () => void;
  /** The saved row for a block. Undefined while its reply streams, and for a draft chat. */
  storedFor: (key: string) => StoredChatArtifact | undefined;
  /** Whether the block is mounted, that is, on the branch the thread shows. */
  hasLive: (key: string) => boolean;
  applyRename: (lineageId: string, userTitle: string | null) => void;
  /** Reloads the saved rows after an edit changed a reply in place. */
  refresh: () => void;
  refreshFailed: boolean;
};

export const ArtifactContext = createContext<ArtifactContextValue | null>(null);

const storedArtifact = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  derivedTitle: z.string(),
  userTitle: z.string().nullable(),
  lineageId: z.string(),
  number: z.number(),
  versions: z.array(versionSummary),
}) satisfies z.ZodType<StoredChatArtifact>;

const chatArtifacts = z.object({ artifacts: z.record(z.string(), storedArtifact) });

function select(key: string | null) {
  const url = new URL(window.location.href);
  if (key === null) url.searchParams.delete("artifact");
  else url.searchParams.set("artifact", key);
  window.history.replaceState(null, "", url);
}

export function ArtifactProvider({ chatId, initialArtifacts, children }: {
  chatId: string;
  initialArtifacts: Record<string, StoredChatArtifact>;
  children: ReactNode;
}) {
  const key = useSearchParams().get("artifact");
  const [artifacts, setArtifacts] = useState(() => new Map<string, Artifact>());
  // The page sends fresh rows after each refresh, and they replace any rows this chat loaded or renamed since.
  const [stored, setStored] = useState(initialArtifacts);
  const [fromPage, setFromPage] = useState(initialArtifacts);
  if (fromPage !== initialArtifacts) {
    setFromPage(initialArtifacts);
    setStored(initialArtifacts);
  }
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useLatestRequest();
  const register = useCallback((artifact: Artifact) => {
    setArtifacts((current) => new Map(current).set(artifact.key, artifact));
    return () => setArtifacts((current) => {
      if (current.get(artifact.key) !== artifact) return current;
      const next = new Map(current);
      next.delete(artifact.key);
      return next;
    });
  }, []);
  const open = useCallback((artifactKey: string) => select(artifactKey), []);
  const close = useCallback(() => select(null), []);
  const storedFor = useCallback((artifactKey: string) => (Object.hasOwn(stored, artifactKey) ? stored[artifactKey] : undefined), [stored]);
  const hasLive = useCallback((artifactKey: string) => artifacts.has(artifactKey), [artifacts]);
  const applyRename = useCallback((lineageId: string, userTitle: string | null) => {
    setStored((current) => Object.fromEntries(Object.entries(current).map(([rowKey, row]) => [
      rowKey,
      row.lineageId === lineageId ? { ...row, userTitle, title: userTitle ?? row.derivedTitle } : row,
    ])));
  }, []);
  const refresh = useCallback(() => {
    const signal = latest();
    void requestJson(`/api/chats/${encodeURIComponent(chatId)}/artifacts`, { signal }, {
      parse: chatArtifacts,
      onOk: (body) => {
        setStored(body.artifacts);
        setRefreshFailed(false);
      },
      onFailed: () => setRefreshFailed(true),
    });
  }, [chatId, latest]);
  const value = useMemo(() => ({
    artifact: key ? artifacts.get(key) : undefined,
    register, open, close, storedFor, hasLive, applyRename, refresh, refreshFailed,
  }), [artifacts, key, register, open, close, storedFor, hasLive, applyRename, refresh, refreshFailed]);
  return createElement(ArtifactContext.Provider, { value }, children);
}

export function useArtifact() {
  return useContext(ArtifactContext);
}

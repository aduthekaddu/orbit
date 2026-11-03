"use client";

import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import type { Artifact } from "@/lib/artifacts/detect";

type ArtifactContextValue = {
  artifact: Artifact | undefined;
  register: (artifact: Artifact) => () => void;
  open: (key: string) => void;
  close: () => void;
};

const ArtifactContext = createContext<ArtifactContextValue | null>(null);

function select(key: string | null) {
  const url = new URL(window.location.href);
  if (key === null) url.searchParams.delete("artifact");
  else url.searchParams.set("artifact", key);
  window.history.replaceState(null, "", url);
}

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const key = useSearchParams().get("artifact");
  const [artifacts, setArtifacts] = useState(() => new Map<string, Artifact>());
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
  const value = useMemo(() => ({ artifact: key ? artifacts.get(key) : undefined, register, open, close }), [artifacts, key, register, open, close]);
  return createElement(ArtifactContext.Provider, { value }, children);
}

export function useArtifact() {
  return useContext(ArtifactContext);
}

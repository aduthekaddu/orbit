"use client";

import { z } from "zod";
import type { ArtifactVersionSummary } from "@/lib/artifacts/store";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { cn } from "@/lib/utils";

export const versionSummary = z.object({
  id: z.string(),
  number: z.number(),
  messageId: z.string(),
  key: z.string(),
  language: z.enum(["html", "svg", "jsx", "tsx"]),
  derivedTitle: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ArtifactVersionSummary>;

/** `v1`, `v2`, `v3`, always on screen while a lineage has more than one version. */
export function ArtifactVersions({ versions, currentId, onSelect }: {
  versions: ArtifactVersionSummary[];
  currentId: string;
  onSelect?: (version: ArtifactVersionSummary) => void;
}) {
  if (versions.length < 2) return null;
  return (
    <ScrollFade axis="x" fade="var(--card)" className="shrink-0 border-b">
      <div role="group" aria-label="Versions" className="flex w-max items-center gap-1 px-2 py-1.5">
        {versions.map((version) => {
          const current = version.id === currentId;
          return (
            <button
              key={version.id}
              type="button"
              aria-current={current ? "true" : undefined}
              onClick={() => { if (!current) onSelect?.(version); }}
              className={cn(
                "num flex h-7 min-w-9 cursor-pointer items-center justify-center rounded-md border px-2 text-meta transition-colors duration-150 ease-orbit outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:min-w-11",
                current ? "border-border-strong bg-surface-raised text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {`v${version.number}`}
            </button>
          );
        })}
      </div>
    </ScrollFade>
  );
}

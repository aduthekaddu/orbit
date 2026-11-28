"use client";

import { AtomIcon, BrowserIcon, FileSvgIcon, type Icon } from "@phosphor-icons/react";
import type { ArtifactKind } from "@/lib/artifacts/detect";
import { ARTIFACT_KIND_LABEL } from "@/lib/artifacts/title";
import { OrbitMark } from "@/components/orbit-mark";
import { Button } from "@/components/ui/button";

export const KIND_ICON: Record<ArtifactKind, Icon> = { html: BrowserIcon, svg: FileSvgIcon, react: AtomIcon };

/**
 * An artifact in the thread: its kind, title, and type, with Open, and Edit when the reply can be edited.
 * `version` is its place in a lineage of several versions.
 */
export function ArtifactCard({ kind, title, version, streaming, onOpen, onEdit }: {
  kind: ArtifactKind;
  title: string;
  version?: number;
  streaming: boolean;
  onOpen: () => void;
  onEdit?: () => void;
}) {
  const KindIcon = KIND_ICON[kind];
  return (
    <div
      data-artifact-card=""
      data-streaming={streaming ? "true" : undefined}
      className="my-4 flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 font-sans shadow-card"
    >
      <div aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-surface-sunken text-muted-foreground">
        {streaming ? <OrbitMark busy tone="accent" className="size-5" /> : <KindIcon weight="light" className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="text-meta text-muted-foreground">
          {ARTIFACT_KIND_LABEL[kind]}
          {version === undefined ? null : <> · <span className="num">{`v${version}`}</span></>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onEdit ? (
          <Button variant="ghost" size="sm" aria-label="Edit code" onClick={onEdit} className="text-muted-foreground hover:text-foreground pointer-coarse:h-11">
            Edit
          </Button>
        ) : null}
        <Button variant="outline" size="sm" aria-label={`Open ${title}`} disabled={streaming} onClick={onOpen} className="pointer-coarse:h-11">
          Open
        </Button>
      </div>
    </div>
  );
}

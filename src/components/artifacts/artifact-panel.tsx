"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAui } from "@assistant-ui/react";
import { XIcon } from "@phosphor-icons/react";
import type { Artifact } from "@/lib/artifacts/detect";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { useCopy } from "@/components/chat/use-copy";
import { cn } from "@/lib/utils";
import { ArtifactFrame } from "./artifact-frame";
import { useArtifact } from "./use-artifact";

const WIDE_SCREEN = "(min-width: 1024px)";
function subscribeWidth(callback: () => void) {
  const media = window.matchMedia(WIDE_SCREEN);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function isWideScreen() { return window.matchMedia(WIDE_SCREEN).matches; }

export function ArtifactWorkspace({ children }: { children: ReactNode }) {
  const context = useArtifact();
  const artifact = context?.artifact;
  const wide = useSyncExternalStore(subscribeWidth, isWideScreen, () => false);
  const close = context?.close;
  useEffect(() => {
    if (!artifact || !wide) return;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") close?.();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [artifact, wide, close]);

  const panel = artifact ? <ArtifactPanel key={artifact.key + artifact.code} artifact={artifact} onClose={() => close?.()} /> : null;
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      {artifact && wide ? <aside aria-label="Artifact" className="h-full min-w-[380px] basis-[45%] shrink-0 border-l">{panel}</aside> : null}
      <Dialog open={Boolean(artifact) && !wide} onOpenChange={(open) => { if (!open) close?.(); }}>
        {!wide && artifact ? (
          <DialogContent showCloseButton={false} aria-describedby={undefined} className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
            <DialogTitle className="sr-only">Artifact</DialogTitle>
            {panel}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

type PreviewState = { status: "loading" } | { status: "ready"; document: string } | { status: "error"; message: string };

function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const aui = useAui();
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const { copied, failed, copy } = useCopy();
  const onError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        let code = artifact.code;
        if (artifact.kind === "react") {
          const { transform } = await import("sucrase");
          code = transform(code, { transforms: ["jsx", "typescript"], jsxRuntime: "automatic", production: true }).code;
        }
        const { artifactDocument } = await import("@/lib/artifacts/document");
        const document = artifactDocument(artifact.kind, code);
        if (active) setPreview({ status: "ready", document });
      } catch (cause) {
        if (active) setPreview({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    void prepare();
    return () => { active = false; };
  }, [artifact]);

  const message = preview.status === "error" ? preview.message : error;

  function download() {
    const extension = { html: "html", svg: "svg", react: "jsx" }[artifact.kind];
    const url = URL.createObjectURL(new Blob([artifact.code], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `artifact.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
      <div className="flex shrink-0 items-center justify-between border-b p-2">
        <div role="tablist" aria-label="Artifact view" className="flex gap-1">
          {(["preview", "code"] as const).map((value) => (
            <Button key={value} role="tab" aria-selected={tab === value} aria-controls={`artifact-${value}`} id={`artifact-tab-${value}`} variant="ghost" size="sm" onClick={() => setTab(value)} className={cn(tab === value && "bg-surface-raised")}>
              {value === "preview" ? "Preview" : "Code"}
            </Button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><XIcon /></Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
        <Button variant="ghost" size="sm" onClick={() => { setError(""); setRevision((current) => current + 1); }}>Reload</Button>
        <Button variant="ghost" size="sm" onClick={() => copy(artifact.code)}>{copied ? "Copied" : failed ? "Copy failed" : "Copy"}</Button>
        <Button variant="ghost" size="sm" onClick={download}>Download</Button>
      </div>
      <div role="tabpanel" id="artifact-preview" aria-labelledby="artifact-tab-preview" hidden={tab !== "preview"} className={cn("min-h-0 flex-1 flex-col", tab === "preview" && "flex")}>
        <div className="min-h-0 flex-1">
          {preview.status === "ready" ? <ArtifactFrame key={revision} document={preview.document} onError={onError} onClose={onClose} /> : preview.status === "loading" ? <span role="status" className="sr-only">Loading preview</span> : null}
        </div>
        {message ? (
          <div role="alert" className="max-h-40 shrink-0 overflow-y-auto border-t p-3 text-sm text-destructive scrollbar-thin">
            <pre className="whitespace-pre-wrap break-words">{message}</pre>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => aui.composer.setText(`Fix this artifact error:\n\n${message}`)}>Fix</Button>
          </div>
        ) : null}
      </div>
      <div role="tabpanel" id="artifact-code" aria-labelledby="artifact-tab-code" hidden={tab !== "code"} className="min-h-0 flex-1 overflow-hidden">
        <ScrollFade axis="x" fade="var(--card)" className="h-full overflow-y-auto scrollbar-thin">
          <pre className="w-max min-w-full p-4 font-mono text-xs leading-5"><code>{artifact.code}</code></pre>
        </ScrollFade>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useAui } from "@assistant-ui/react";
import { XIcon } from "@phosphor-icons/react";
import { Highlight } from "prism-react-renderer";
import type { Artifact } from "@/lib/artifacts/detect";
import { artifactFileName, artifactTitle } from "@/lib/artifacts/title";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { orbitCodeTheme } from "@/components/chat/code-theme";
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
  const aui = useAui();
  const chat = useRef<HTMLDivElement>(null);
  const focusAfterClose = useRef(false);
  const context = useArtifact();
  const artifact = context?.artifact;
  const wide = useSyncExternalStore(subscribeWidth, isWideScreen, () => false);
  const close = context?.close;
  useEffect(() => {
    if (!artifact || !wide) return;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) close?.();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [artifact, wide, close]);

  function focusComposer() {
    chat.current?.querySelector<HTMLTextAreaElement>('[data-aui-composer-type="thread"] textarea[name="input"]')?.focus();
  }

  function fix(message: string) {
    aui.composer.setText(`Fix this artifact error:\n\n${message}`);
    if (wide) focusComposer();
    else {
      focusAfterClose.current = true;
      close?.();
    }
  }

  const panel = artifact ? <ArtifactPanel key={artifact.key + artifact.code} artifact={artifact} onClose={() => close?.()} onFix={fix} /> : null;
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div ref={chat} className="min-h-0 min-w-0 flex-1">{children}</div>
      {artifact && wide ? <aside aria-label="Artifact" className="h-full min-w-[380px] basis-[45%] shrink-0 border-l">{panel}</aside> : null}
      <Dialog open={Boolean(artifact) && !wide} onOpenChange={(open) => { if (!open) close?.(); }}>
        {!wide && artifact ? (
          <DialogContent showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={(event) => {
            if (!focusAfterClose.current) return;
            event.preventDefault();
            focusAfterClose.current = false;
            focusComposer();
          }} className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
            <DialogTitle className="sr-only">Artifact</DialogTitle>
            {panel}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

type PreviewState = { status: "loading" } | { status: "ready"; document: string } | { status: "error"; message: string };

/**
 * The highlighted source. Each line is a block span that ends with the source's own line break, so the
 * text of the <code> element is the artifact code exactly and Copy matches what the tab shows.
 */
function ArtifactCode({ artifact }: { artifact: Artifact }) {
  const breaks = useMemo(() => artifact.code.match(/\r\n|\r|\n/g) ?? [], [artifact.code]);
  return (
    <Highlight code={artifact.code} language={artifact.language} theme={orbitCodeTheme}>
      {({ tokens, getTokenProps }) => (
        <pre className="w-max min-w-full p-4 font-mono text-code">
          <code>
            {tokens.map((line, index) => (
              <span key={index} className="block">
                {line.map((token, key) => (token.empty ? null : <span key={key} {...getTokenProps({ token })} />))}
                {breaks[index] ?? ""}
              </span>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

export function ArtifactPanel({ artifact, onClose, onFix }: { artifact: Artifact; onClose: () => void; onFix: (message: string) => void }) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const previewTab = useRef<HTMLButtonElement>(null);
  const codeTab = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const { copied, failed, copy } = useCopy();
  const onError = useCallback((message: string) => setError(message), []);
  const title = useMemo(() => artifactTitle(artifact), [artifact]);

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
    const url = URL.createObjectURL(new Blob([artifact.code], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactFileName(artifact);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, value: typeof tab) {
    let next: typeof tab;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": next = value === "preview" ? "code" : "preview"; break;
      case "Home": next = "preview"; break;
      case "End": next = "code"; break;
      default: return;
    }
    event.preventDefault();
    setTab(next);
    (next === "preview" ? previewTab : codeTab).current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <h2 className="min-w-0 flex-1 truncate pl-1 text-sm font-medium">{title}</h2>
        <div role="tablist" aria-label="Artifact view" className="flex shrink-0 gap-1">
          {(["preview", "code"] as const).map((value) => (
            <Button key={value} ref={value === "preview" ? previewTab : codeTab} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`artifact-${value}`} id={`artifact-tab-${value}`} variant="ghost" size="sm" onClick={() => setTab(value)} onKeyDown={(event) => tabKeyDown(event, value)} className={cn("pointer-coarse:h-11", tab === value && "bg-surface-raised")}>
              {value === "preview" ? "Preview" : "Code"}
            </Button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="pointer-coarse:size-11"><XIcon /></Button>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => { setError(""); setRevision((current) => current + 1); }}>Reload</Button>
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => copy(artifact.code)}>{copied ? "Copied" : failed ? "Copy failed" : "Copy"}</Button>
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={download}>Download</Button>
      </div>
      <div role="tabpanel" id="artifact-preview" aria-labelledby="artifact-tab-preview" hidden={tab !== "preview"} className={cn("min-h-0 flex-1 flex-col", tab === "preview" && "flex")}>
        <div className="min-h-0 flex-1">
          {preview.status === "ready" ? <ArtifactFrame key={revision} document={preview.document} onError={onError} onClose={onClose} /> : preview.status === "loading" ? <span role="status" className="sr-only">Loading preview</span> : null}
        </div>
        {message ? (
          <div role="alert" className="shrink-0 border-t text-sm text-destructive">
            <ScrollFade axis="y" fade="var(--card)" scrollerClassName="max-h-40 p-3">
              <pre className="whitespace-pre-wrap break-words">{message}</pre>
            </ScrollFade>
            <div className="px-3 pb-3">
              <Button variant="outline" size="sm" onClick={() => onFix(message)}>Fix</Button>
            </div>
          </div>
        ) : null}
      </div>
      <div role="tabpanel" id="artifact-code" aria-labelledby="artifact-tab-code" hidden={tab !== "code"} className="min-h-0 flex-1 overflow-hidden bg-surface-sunken">
        <ScrollFade axis="x" fade="var(--surface-sunken)" className="h-full overflow-y-auto scrollbar-thin">
          <ArtifactCode artifact={artifact} />
        </ScrollFade>
      </div>
    </div>
  );
}

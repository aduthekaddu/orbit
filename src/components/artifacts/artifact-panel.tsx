"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useAui } from "@assistant-ui/react";
import { ArrowClockwiseIcon, ArrowLeftIcon, CheckIcon, CopyIcon, DownloadSimpleIcon, PencilSimpleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Highlight } from "prism-react-renderer";
import type { Artifact } from "@/lib/artifacts/detect";
import type { ArtifactVersionSummary, StoredChatArtifact } from "@/lib/artifacts/store";
import { artifactFileName, artifactTitle } from "@/lib/artifacts/title";
import { requestJson } from "@/lib/request-json";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { useChatId } from "@/components/chat/chat-id";
import { orbitCodeTheme } from "@/components/chat/code-theme";
import { IconAction, iconActionClass } from "@/components/chat/icon-action";
import { useCopy } from "@/components/chat/use-copy";
import { cn } from "@/lib/utils";
import { ArtifactDiff } from "./artifact-diff";
import { ArtifactFrame } from "./artifact-frame";
import { ArtifactVersions } from "./artifact-versions";
import { useArtifact } from "./use-artifact";
import { useArtifactTheme } from "./use-artifact-theme";

const WIDE_SCREEN = "(min-width: 1024px)";
function subscribeWidth(callback: () => void) {
  const media = window.matchMedia(WIDE_SCREEN);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function isWideScreen() { return window.matchMedia(WIDE_SCREEN).matches; }

/** Escape in the title field cancels the rename and leaves the panel, its dialog, and the drawer open. */
function inRename(event: Event) {
  return event.target instanceof HTMLElement && event.target.closest("[data-artifact-rename]") !== null;
}

export function ArtifactWorkspace({ children }: { children: ReactNode }) {
  const aui = useAui();
  const router = useRouter();
  const chatId = useChatId();
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

  // A version on the open branch opens in place. Another branch's version reloads the chat on that branch.
  function selectVersion(version: ArtifactVersionSummary) {
    if (context?.hasLive(version.key)) context.open(version.key);
    else router.push(`/c/${chatId}?m=${encodeURIComponent(version.messageId)}&artifact=${encodeURIComponent(version.key)}`);
  }

  const stored = artifact ? context?.storedFor(artifact.key) : undefined;
  const panel = artifact ? (
    <ArtifactPanel
      key={stored?.lineageId ?? artifact.key}
      artifact={artifact}
      stored={stored}
      onClose={() => close?.()}
      onFix={fix}
      onSelectVersion={selectVersion}
      onRenamed={(result) => context?.applyRename(result.lineageId, result.userTitle)}
    />
  ) : null;
  const stale = context?.refreshFailed ? (
    <div role="alert" className="flex shrink-0 items-center gap-3 border-b bg-card px-3 py-2 text-sm text-destructive">
      <span className="min-w-0 flex-1">Could not refresh artifacts</span>
      <Button variant="outline" size="sm" onClick={() => context.refresh()} className="pointer-coarse:h-11">Retry</Button>
    </div>
  ) : null;
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div ref={chat} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* With the panel closed the failure shows above the thread, since an edit in the thread started the refresh. */}
        {artifact ? null : stale}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      {artifact && wide ? (
        <aside aria-label="Artifact" className="flex h-full min-w-[380px] basis-[45%] shrink-0 flex-col border-l">
          {stale}
          <div className="min-h-0 flex-1">{panel}</div>
        </aside>
      ) : null}
      <Dialog open={Boolean(artifact) && !wide} onOpenChange={(open) => { if (!open) close?.(); }}>
        {!wide && artifact ? (
          <DialogContent showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={(event) => { if (inRename(event)) event.preventDefault(); }} onCloseAutoFocus={(event) => {
            if (!focusAfterClose.current) return;
            event.preventDefault();
            focusAfterClose.current = false;
            focusComposer();
          }} className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
            <DialogTitle className="sr-only">Artifact</DialogTitle>
            {stale}
            <div className="min-h-0 flex-1">{panel}</div>
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

/** The sandboxed render and its runtime error. Its parent remounts it for each version, each edit, and each Reload. */
function ArtifactPreview({ artifact, onClose, onFix }: { artifact: Artifact; onClose?: () => void; onFix?: (message: string) => void }) {
  const { kind, code } = artifact;
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const onError = useCallback((message: string) => setError(message), []);
  // A theme change rebuilds the document, which reloads the preview.
  const theme = useArtifactTheme();

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        let source = code;
        if (kind === "react") {
          const { transform } = await import("sucrase");
          source = transform(source, { transforms: ["jsx", "typescript"], jsxRuntime: "automatic", production: true }).code;
        }
        const { artifactDocument } = await import("@/lib/artifacts/document");
        const document = artifactDocument(kind, source, theme);
        if (active) setPreview({ status: "ready", document });
      } catch (cause) {
        if (active) setPreview({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    void prepare();
    return () => { active = false; };
  }, [kind, code, theme]);

  const message = preview.status === "error" ? preview.message : error;
  return (
    <>
      <div className="min-h-0 flex-1">
        {preview.status === "ready" ? <ArtifactFrame document={preview.document} onError={onError} onClose={onClose} /> : preview.status === "loading" ? <span role="status" className="sr-only">Loading preview</span> : null}
      </div>
      {message ? (
        <div role="alert" className="shrink-0 border-t text-sm text-destructive">
          <ScrollFade axis="y" fade="var(--card)" scrollerClassName="max-h-40 p-3">
            <pre className="whitespace-pre-wrap break-words">{message}</pre>
          </ScrollFade>
          {onFix ? (
            <div className="px-3 pb-3">
              <Button variant="outline" size="sm" onClick={() => onFix(message)}>Fix</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** What a rename sends: the tidied title, `""` to clear a rename, or null when nothing would change. */
export function renameRequest(current: { title: string; userTitle: string | null }, typed: string): string | null {
  const title = typed.trim().replace(/\s+/g, " ");
  if (title === "") return current.userTitle === null ? null : "";
  return title === current.title ? null : title;
}

const TITLE_MAX = 80;

const renamed = z.object({ id: z.string(), lineageId: z.string(), userTitle: z.string().nullable(), title: z.string() });

export type RenameResult = { lineageId: string; userTitle: string | null; title: string };

type Rename = { status: "idle" } | { status: "editing" } | { status: "saving"; title: string } | { status: "failed" };

type View = "preview" | "code" | "diff";

const VIEW_LABEL: Record<View, string> = { preview: "Preview", code: "Code", diff: "Diff" };

export type PanelStored = Pick<StoredChatArtifact, "id" | "lineageId" | "title" | "derivedTitle" | "userTitle" | "number" | "versions">;

export function ArtifactPanel({ artifact, stored, onClose, onFix, onSelectVersion, onRenamed, openInChatHref, onBack }: {
  artifact: Artifact;
  stored?: PanelStored;
  onClose?: () => void;
  onFix?: (message: string) => void;
  onSelectVersion?: (version: ArtifactVersionSummary) => void;
  onRenamed?: (result: RenameResult) => void;
  openInChatHref?: string;
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<View>("preview");
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});
  const [revision, setRevision] = useState(0);
  const [rename, setRename] = useState<Rename>({ status: "idle" });
  const titleInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  // Enter, Escape and blur all end a rename; only the first one counts.
  const renameEnded = useRef(false);
  const refocusRename = useRef(false);
  // Set while focus returns to Rename after a rename ends, which opens no tooltip.
  const quietFocus = useRef(false);
  const { copied, failed, copy } = useCopy();
  const derived = useMemo(() => artifactTitle(artifact), [artifact]);
  // The code's own title stays right after an edit in place, before the saved rows catch up.
  const savedTitle = stored ? stored.userTitle ?? derived : derived;
  const title = rename.status === "saving" ? rename.title : savedTitle;
  const views: View[] = stored && stored.versions.length > 1 ? ["preview", "code", "diff"] : ["preview", "code"];
  const view = views.includes(tab) ? tab : "preview";

  useEffect(() => {
    if (rename.status !== "editing") return;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [rename.status]);

  useEffect(() => {
    if (rename.status === "editing" || !refocusRename.current) return;
    refocusRename.current = false;
    quietFocus.current = true;
    renameButton.current?.focus();
    quietFocus.current = false;
  }, [rename.status]);

  function startRename() {
    renameEnded.current = false;
    setRename({ status: "editing" });
  }

  function endRename(commit: boolean, refocus: boolean) {
    if (renameEnded.current || !stored) return;
    renameEnded.current = true;
    refocusRename.current = refocus;
    const sent = commit ? renameRequest({ title: savedTitle, userTitle: stored.userTitle }, titleInput.current?.value ?? "") : null;
    if (sent === null) {
      setRename({ status: "idle" });
      return;
    }
    setRename({ status: "saving", title: sent || derived });
    void requestJson(`/api/artifacts/${encodeURIComponent(stored.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: sent }),
    }, {
      parse: renamed,
      onOk: (result) => {
        onRenamed?.(result);
        setRename({ status: "idle" });
      },
      onFailed: () => setRename({ status: "failed" }),
    });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([artifact.code], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactFileName(artifact, title);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, value: View) {
    const index = views.indexOf(value);
    let next: View;
    switch (event.key) {
      case "ArrowLeft": next = views[(index - 1 + views.length) % views.length]; break;
      case "ArrowRight": next = views[(index + 1) % views.length]; break;
      case "Home": next = views[0]; break;
      case "End": next = views[views.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  const copyLabel = copied ? "Copied" : failed ? "Copy failed" : "Copy";
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
        {onBack ? (
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack} className="lg:hidden pointer-coarse:size-11"><ArrowLeftIcon /></Button>
        ) : null}
        {rename.status === "editing" ? (
          <input
            ref={titleInput}
            type="text"
            aria-label="Artifact title"
            data-artifact-rename=""
            defaultValue={savedTitle}
            placeholder={derived}
            maxLength={TITLE_MAX}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                endRename(true, true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                endRename(false, true);
              }
            }}
            onBlur={() => endRename(true, false)}
            className="h-8 min-w-0 flex-1 rounded-md border bg-surface-sunken px-2 text-field text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11"
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <h2 className="min-w-0 truncate pl-1 text-sm font-medium">{title}</h2>
            {stored ? (
              <IconAction label="Rename artifact">
                <button
                  ref={renameButton}
                  type="button"
                  // Radix opens no tooltip for a prevented focus. It would cover the versions strip and take its clicks.
                  onFocus={(event) => { if (quietFocus.current) event.preventDefault(); }}
                  onClick={() => { if (rename.status !== "saving") startRename(); }}
                  className={cn(iconActionClass, "shrink-0")}
                >
                  <PencilSimpleIcon weight="light" />
                </button>
              </IconAction>
            ) : null}
          </div>
        )}
        {openInChatHref ? (
          <Button asChild variant="ghost" size="sm" className="pointer-coarse:h-11">
            <Link href={openInChatHref}>Open in chat</Link>
          </Button>
        ) : null}
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="pointer-coarse:size-11"><XIcon /></Button>
        ) : null}
      </div>
      {rename.status === "failed" ? (
        <p role="alert" className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-meta text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          Could not rename
        </p>
      ) : null}
      {stored ? <ArtifactVersions versions={stored.versions} currentId={stored.id} onSelect={onSelectVersion} /> : null}
      {/* At a large text size on a phone the actions drop under the tabs instead of widening the page. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b p-2">
        <div role="tablist" aria-label="Artifact view" className="flex gap-1">
          {views.map((value) => (
            <Button key={value} ref={(node) => { tabRefs.current[value] = node; }} role="tab" tabIndex={view === value ? 0 : -1} aria-selected={view === value} aria-controls={`artifact-${value}`} id={`artifact-tab-${value}`} variant="ghost" size="sm" onClick={() => setTab(value)} onKeyDown={(event) => tabKeyDown(event, value)} className={cn("pointer-coarse:h-11", view === value && "bg-surface-raised")}>
              {VIEW_LABEL[value]}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <span aria-live="polite" className="sr-only">{copied ? "Copied" : failed ? "Copy failed" : ""}</span>
          <IconAction label="Reload">
            <button type="button" onClick={() => setRevision((current) => current + 1)} className={iconActionClass}><ArrowClockwiseIcon weight="light" /></button>
          </IconAction>
          <IconAction label={copyLabel}>
            <button type="button" onClick={() => copy(artifact.code)} className={iconActionClass}>
              {copied ? <CheckIcon weight="regular" /> : failed ? <WarningCircleIcon weight="regular" className="text-destructive" /> : <CopyIcon weight="light" />}
            </button>
          </IconAction>
          <IconAction label="Download">
            <button type="button" onClick={download} className={iconActionClass}><DownloadSimpleIcon weight="light" /></button>
          </IconAction>
        </div>
      </div>
      <div role="tabpanel" id="artifact-preview" aria-labelledby="artifact-tab-preview" hidden={view !== "preview"} className={cn("min-h-0 flex-1 flex-col", view === "preview" && "flex")}>
        <ArtifactPreview key={`${artifact.key}\n${revision}\n${artifact.code}`} artifact={artifact} onClose={onClose} onFix={onFix} />
      </div>
      <div role="tabpanel" id="artifact-code" aria-labelledby="artifact-tab-code" hidden={view !== "code"} className="min-h-0 flex-1 overflow-hidden bg-surface-sunken">
        <ScrollFade axis="x" fade="var(--surface-sunken)" className="h-full overflow-y-auto scrollbar-thin">
          <ArtifactCode artifact={artifact} />
        </ScrollFade>
      </div>
      {views.includes("diff") ? (
        <div role="tabpanel" id="artifact-diff" aria-labelledby="artifact-tab-diff" hidden={view !== "diff"} className={cn("min-h-0 flex-1 flex-col", view === "diff" && "flex")}>
          {view === "diff" && stored ? <ArtifactDiff current={{ id: stored.id, code: artifact.code }} versions={stored.versions} /> : null}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Highlight } from "prism-react-renderer";
import type { CodeHeaderProps, SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { CaretDownIcon, CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { artifactKind, isArtifactLanguage } from "@/lib/artifacts/detect";
import { artifactTitle } from "@/lib/artifacts/title";
import { useArtifact } from "@/components/artifacts/use-artifact";
import { codeBodyStart, replaceCode } from "@/lib/chat-parts";
import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ArtifactCard } from "./artifact-card";
import { useCodeEdit } from "./code-edit-context";
import { orbitCodeTheme } from "./code-theme";
import { EditorFooter } from "./editor-footer";
import { useCopy } from "./use-copy";

// Past this many lines a block opens capped at COLLAPSED_LINES, so one answer cannot become a wall of code.
const COLLAPSE_AFTER = 20;
const COLLAPSED_LINES = 14;

const headerButton = "flex h-6 pointer-coarse:h-11 items-center rounded-md px-2 text-meta text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

type BlockNode = CodeHeaderProps["node"] | SyntaxHighlighterProps["node"];

function fenceOffset(node: BlockNode) {
  const value = node?.properties?.["data-code-fence"];
  return typeof value === "number" ? value : node?.position?.start?.offset;
}

function codeIndex(node: BlockNode) {
  const value = node?.properties?.["data-code-index"];
  return typeof value === "number" ? value : undefined;
}

/**
 * Where a fenced block sits in its message, and whether it is an artifact. Only assistant text parts
 * have a text ordinal, so a block inside Reasoning has no key and stays a plain code block (#137).
 */
function useCodeBlock(language: string | undefined, code: string, node: BlockNode) {
  const edit = useCodeEdit();
  const artifacts = useArtifact();
  const start = edit ? codeBodyStart(edit.text, fenceOffset(node), code) : -1;
  const active = Boolean(edit?.enabled) && edit?.active === start;
  const index = codeIndex(node);
  const sourceLanguage = typeof language === "string" && isArtifactLanguage(language) ? language : undefined;
  const kind = sourceLanguage && artifactKind(sourceLanguage);
  const key = edit && index !== undefined && edit.textOrdinal !== undefined ? `${edit.messageId}.${edit.textOrdinal}.${index}` : null;
  const artifact = artifacts && sourceLanguage && kind && key ? { key, kind, language: sourceLanguage } : null;
  const wrapped = index !== undefined && Boolean(edit?.wrapped.has(index));
  return { edit, artifacts, start, active, index, artifact, wrapped };
}

export function CodeHeader({ language, code, node }: CodeHeaderProps) {
  const { copied, failed, copy } = useCopy();
  const { edit, artifacts, start, active, index, artifact, wrapped } = useCodeBlock(language, code, node);
  const register = artifacts?.register;
  const messageId = edit?.messageId;
  const key = artifact?.key;
  const kind = artifact?.kind;
  const sourceLanguage = artifact?.language;
  useEffect(() => {
    if (!register || !kind || !key || !sourceLanguage || !messageId) return;
    return register({ key, kind, code, language: sourceLanguage });
  }, [register, kind, key, code, sourceLanguage, messageId]);
  const title = useMemo(() => (kind ? artifactTitle({ kind, code }) : ""), [kind, code]);

  if (artifacts && kind && key && !active) {
    return (
      <ArtifactCard
        kind={kind}
        title={title}
        streaming={Boolean(edit?.streaming)}
        onOpen={() => artifacts.open(key)}
        onEdit={edit?.enabled ? () => edit.setActive(start) : undefined}
      />
    );
  }

  return (
    <div
      className={cn(
        "mt-4 flex h-8 pointer-coarse:h-11 items-center justify-between rounded-t-lg border border-b-0 bg-surface-sunken pr-1 pl-3 transition-colors duration-150 ease-orbit",
        active && "border-primary/40",
      )}
    >
      <span className="font-mono text-meta text-muted-foreground">{language || "text"}</span>
      <span aria-live="polite" className="sr-only">{copied ? "Copied" : failed ? "Copy failed" : ""}</span>
      {active ? null : (
        <div className="flex items-center gap-0.5">
          {edit && index !== undefined ? (
            <button
              type="button"
              aria-pressed={wrapped}
              onClick={() => edit.toggleWrap(index)}
              className={cn(headerButton, "aria-pressed:bg-surface-raised aria-pressed:text-foreground")}
            >
              Wrap
            </button>
          ) : null}
          {edit?.enabled ? (
            <button type="button" onClick={() => edit.setActive(start)} aria-label="Edit code" className={headerButton}>
              Edit
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => copy(code)}
            aria-label={copied ? "Copied" : failed ? "Copy failed" : "Copy code"}
            className="flex size-6 pointer-coarse:size-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {copied ? <CheckIcon weight="regular" className="size-3.5" /> : failed ? <WarningCircleIcon className="size-3.5 text-destructive" /> : <CopyIcon weight="regular" className="size-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

function CodeEditor({ code, start, language }: { code: string; start: number; language: string }) {
  const edit = useCodeEdit();
  const [draft, setDraft] = useState(code);

  async function commit() {
    if (!edit || edit.saving) return;
    const next = replaceCode(edit.text, code, draft, start, start + code.length);
    if (next === edit.text) {
      edit.setActive(null);
      return;
    }
    if (await edit.save(edit.messageId, next)) edit.setActive(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      edit?.setActive(null);
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!edit?.saving) void commit();
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-b-lg border border-primary/40 bg-surface-sunken">
      <textarea
        autoFocus
        spellCheck={false}
        readOnly={edit?.saving}
        value={draft}
        aria-label={`Edit ${language || "code"} block`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className="block max-h-[60vh] min-h-20 w-full resize-none bg-transparent px-3 py-3 font-mono text-field whitespace-pre outline-none field-sizing-content scrollbar-thin"
      />
      <EditorFooter error={edit?.error} saving={edit?.saving} onCancel={() => edit?.setActive(null)} onSave={() => void commit()} />
    </div>
  );
}

/** `standalone` is a block shown without CodeHeader above it, such as a schema on /tools, so every corner is round. */
export function SyntaxHighlighter({
  code,
  language,
  node,
  standalone = false,
}: Omit<SyntaxHighlighterProps, "components"> & Partial<Pick<SyntaxHighlighterProps, "components">> & { standalone?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { start, active, artifact, wrapped } = useCodeBlock(language, code, node);

  if (active) return <CodeEditor code={code} start={start} language={language} />;
  // The artifact card in CodeHeader stands in for the code until someone edits it.
  if (artifact) return null;

  const source = code.replace(/\n$/, "");
  const lines = source.split("\n").length;
  const collapsible = lines > COLLAPSE_AFTER;
  const capped = collapsible && !expanded;
  return (
    <div className={cn("overflow-hidden border bg-surface-sunken", standalone ? "rounded-lg" : "mb-4 rounded-b-lg")}>
      <div className="relative">
        <ScrollFade
          axis="x"
          fade="var(--surface-sunken)"
          className={cn(capped && "overflow-hidden")}
          style={capped ? { maxHeight: `calc(${COLLAPSED_LINES} * 1.5rem + 0.75rem)` } : undefined}
        >
          <Highlight code={source} language={language} theme={orbitCodeTheme}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className={cn("px-3 py-3 font-mono text-code", wrapped ? "w-full whitespace-pre-wrap break-words" : "w-max min-w-full")}>
                <code>
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </code>
              </pre>
            )}
          </Highlight>
        </ScrollFade>
        {capped && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface-sunken" />
        )}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 border-t text-meta text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {expanded ? "Show less" : <span><span className="num">{lines - COLLAPSED_LINES}</span> more lines</span>}
          <CaretDownIcon weight="regular" className={cn("size-3 transition-transform duration-200 ease-orbit", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

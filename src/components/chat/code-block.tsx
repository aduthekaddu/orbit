"use client";

import { useState, type KeyboardEvent } from "react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import type { CodeHeaderProps, SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { CaretDownIcon, CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { codeBodyStart, replaceCode } from "@/lib/chat-parts";
import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { useCodeEdit } from "./code-edit-context";
import { EditorFooter } from "./editor-footer";
import { useCopy } from "./use-copy";

// Past this many lines a block opens capped at COLLAPSED_LINES, so one answer cannot become a wall of code.
const COLLAPSE_AFTER = 20;
const COLLAPSED_LINES = 14;

const orbitCodeTheme: PrismTheme = {
  plain: { color: "var(--foreground)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--syntax-comment)", fontStyle: "italic" } },
    { types: ["keyword", "boolean", "important", "atrule", "null"], style: { color: "var(--syntax-keyword)" } },
    {
      types: ["string", "char", "attr-value", "template-string", "triple-quoted-string"],
      style: { color: "var(--syntax-string)" },
    },
    { types: ["number", "constant", "symbol"], style: { color: "var(--syntax-number)" } },
    { types: ["function", "function-variable", "method"], style: { color: "var(--syntax-function)" } },
    { types: ["builtin", "class-name"], style: { color: "var(--syntax-class)" } },
    { types: ["property", "property-access"], style: { color: "var(--syntax-function)" } },
    { types: ["operator", "entity", "url"], style: { color: "var(--syntax-operator)" } },
    { types: ["punctuation"], style: { color: "var(--syntax-punctuation)" } },
    { types: ["decorator", "interpolation-punctuation", "format-spec"], style: { color: "var(--syntax-builtin)" } },
  ],
};

export function CodeHeader({ language, code, node }: CodeHeaderProps) {
  const { copied, failed, copy } = useCopy();
  const edit = useCodeEdit();
  const start = edit ? codeBodyStart(edit.text, node?.position?.start?.offset, code) : -1;
  const active = edit?.active === start;

  return (
    <div
      className={cn(
        "mt-4 flex h-8 pointer-coarse:h-11 items-center justify-between rounded-t-lg border border-b-0 bg-surface-sunken pr-1 pl-3 transition-colors duration-150 ease-orbit",
        active && "border-primary/40",
      )}
    >
      <span className="font-mono text-2xs text-muted-foreground">{language || "text"}</span>
      <span aria-live="polite" className="sr-only">{copied ? "Copied" : failed ? "Copy failed" : ""}</span>
      {active ? null : (
        <div className="flex items-center gap-0.5">
          {edit?.enabled ? (
            <button
              type="button"
              onClick={() => edit.setActive(start)}
              aria-label="Edit code"
              className="flex h-6 pointer-coarse:h-11 items-center rounded-md px-2 text-2xs text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
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
        className="block max-h-[60vh] min-h-20 w-full resize-none bg-transparent px-3 py-3 font-mono text-xs leading-5 whitespace-pre outline-none field-sizing-content scrollbar-thin"
      />
      <EditorFooter error={edit?.error} saving={edit?.saving} onCancel={() => edit?.setActive(null)} onSave={() => void commit()} />
    </div>
  );
}

export function SyntaxHighlighter({ code, language, node }: SyntaxHighlighterProps) {
  const edit = useCodeEdit();
  const [expanded, setExpanded] = useState(false);
  const start = edit ? codeBodyStart(edit.text, node?.position?.start?.offset, code) : -1;
  const active = edit?.enabled && edit.active === start;

  if (active) return <CodeEditor code={code} start={start} language={language} />;

  const source = code.replace(/\n$/, "");
  const lines = source.split("\n").length;
  const collapsible = lines > COLLAPSE_AFTER;
  const capped = collapsible && !expanded;
  return (
    <div className="mb-4 overflow-hidden rounded-b-lg border bg-surface-sunken">
      <div className="relative">
        <ScrollFade
          axis="x"
          fade="var(--surface-sunken)"
          className={cn(capped && "overflow-hidden")}
          style={capped ? { maxHeight: `calc(${COLLAPSED_LINES} * 1.25rem + 0.75rem)` } : undefined}
        >
          <Highlight code={source} language={language} theme={orbitCodeTheme}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="w-max min-w-full px-3 py-3 font-mono text-xs leading-5">
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
          className="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 border-t text-2xs text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {expanded ? "Show less" : <span><span className="num">{lines - COLLAPSED_LINES}</span> more lines</span>}
          <CaretDownIcon weight="regular" className={cn("size-3 transition-transform duration-200 ease-orbit", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

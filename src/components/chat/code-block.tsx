"use client";

import { Highlight, type PrismTheme } from "prism-react-renderer";
import type { CodeHeaderProps, SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useCopy } from "./use-copy";

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

export function CodeHeader({ language, code }: CodeHeaderProps) {
  const { copied, copy } = useCopy();
  return (
    <div className="mt-4 flex h-8 items-center justify-between rounded-t-lg border border-b-0 bg-surface-sunken pr-1 pl-3">
      <span className="font-mono text-2xs text-muted-foreground">{language || "text"}</span>
      <button
        type="button"
        onClick={() => copy(code)}
        aria-label={copied ? "Copied" : "Copy code"}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-orbit hover:bg-accent hover:text-foreground"
      >
        {copied ? <CheckIcon weight="regular" className="size-3.5" /> : <CopyIcon weight="regular" className="size-3.5" />}
      </button>
    </div>
  );
}

export function SyntaxHighlighter({ code, language }: SyntaxHighlighterProps) {
  return (
    <Highlight code={code.replace(/\n$/, "")} language={language} theme={orbitCodeTheme}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="mb-4 overflow-x-auto rounded-b-lg border bg-surface-sunken px-3 py-3 font-mono text-xs leading-5 scrollbar-thin">
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
  );
}

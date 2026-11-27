"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ElementType, type JSX } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { textPartIndex } from "@/lib/chat-parts";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { rehypeCodeBlocks } from "@/lib/markdown-code";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { CodeEditContext } from "./code-edit-context";
import { CodeHeader, SyntaxHighlighter } from "./code-block";
import { useSaveMessageText } from "./use-save-message";

type Tag = keyof JSX.IntrinsicElements;

function styled<T extends Tag>(tag: T, base: string) {
  const Element = tag as ElementType;
  function Styled({ node: _node, className, ...props }: ComponentProps<T> & { node?: unknown }) {
    return <Element className={cn(base, className)} {...props} />;
  }
  Styled.displayName = `md.${tag}`;
  return Styled;
}

const elementClasses = {
  h1: "mt-8 mb-3 text-h1 font-semibold tracking-tight text-balance",
  h2: "mt-8 mb-3 text-h2 font-semibold tracking-tight text-balance",
  h3: "mt-6 mb-2 text-h3 font-semibold text-balance",
  h4: "mt-6 mb-2 text-h4 font-semibold",
  h5: "mt-5 mb-1.5 text-h5 font-semibold",
  h6: "mt-5 mb-1.5 text-h6 font-medium text-muted-foreground",
  p: "my-4",
  ul: "my-4 list-disc pl-6 marker:text-muted-foreground [&_ol]:my-1.5 [&_ul]:my-1.5",
  ol: "my-4 list-decimal pl-6 marker:text-muted-foreground marker:tabular-nums [&_ol]:my-1.5 [&_ul]:my-1.5",
  li: "my-1.5 pl-1",
  blockquote: "my-4 border-l-2 border-border-strong pl-4 text-muted-foreground",
  hr: "my-8 border-t",
  strong: "font-semibold text-foreground",
  code: "rounded-sm border bg-surface-sunken px-1 py-px font-mono text-[length:max(0.85em,13px)]",
  thead: "border-b border-border-strong",
  tr: "border-b last:border-b-0",
  th: "px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground",
  td: "px-3 py-2 align-top tabular-nums",
} as const satisfies Partial<Record<Tag, string>>;

const styledElements = Object.fromEntries(
  Object.entries(elementClasses).map(([tag, base]) => [tag, styled(tag as Tag, base)]),
);

const InLink = createContext(false);

function Link({ node: _node, className, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return (
    <InLink.Provider value={true}>
      <a
        target="_blank"
        rel="noreferrer noopener"
        className={cn("text-foreground underline decoration-sun/50 underline-offset-2 hover:decoration-sun", className)}
        {...props}
      />
    </InLink.Provider>
  );
}

function ImageLink({ src, alt, title }: ComponentProps<"img">) {
  const inLink = useContext(InLink);
  const href = typeof src === "string" ? src : undefined;
  const label = alt?.trim() || href;
  if (!href || inLink) return label;
  return <Link href={href} title={title}>{label}</Link>;
}

function Table({ node: _node, className, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="my-4 overflow-hidden rounded-lg border">
      <ScrollFade axis="x" fade="var(--background)">
        <table className={cn("w-full border-collapse text-sm", className)} {...props} />
      </ScrollFade>
    </div>
  );
}

export const components = { ...styledElements, a: Link, img: ImageLink, table: Table, CodeHeader, SyntaxHighlighter };
const remarkPlugins = [remarkGfm];

const rehypePlugins = [rehypeCodeBlocks];

export function MarkdownText({ className, editable = false }: { className?: string; editable?: boolean }) {
  const aui = useAui();
  const chat = useAISDKChat();
  const partText = useAuiState((s) => (s.part.type === "text" ? s.part.text : ""));
  const textOrdinal = useAuiState((s) => {
    const query = aui.part.query;
    if (s.part.type !== "text" || !query || !("index" in query) || typeof query.index !== "number") return undefined;
    return s.message.parts.slice(0, query.index).filter((part) => part.type === "text").length;
  });
  const messageId = useAuiState((s) => s.message.id);
  const sourceMessage = chat?.messages.find((message) => message.id === messageId);
  const sourceIndex = sourceMessage && textOrdinal !== undefined ? textPartIndex(sourceMessage.parts, textOrdinal) : undefined;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const [active, setActive] = useState<number | null>(null);
  const [wrapped, setWrapped] = useState<ReadonlySet<number>>(() => new Set());
  const toggleWrap = useCallback((index: number) => setWrapped((current) => {
    const next = new Set(current);
    if (!next.delete(index)) next.add(index);
    return next;
  }), []);
  const { save, saving, error } = useSaveMessageText();

  const codeEdit = useMemo(
    () => ({
      enabled: editable && Boolean(messageId) && !running,
      streaming: running,
      text: partText, textOrdinal, active, setActive, messageId, saving, error, wrapped, toggleWrap,
      save: (id: string, text: string) => {
        if (sourceIndex === undefined) return Promise.resolve(false);
        return save(id, text, sourceIndex);
      },
    }),
    [editable, messageId, running, partText, textOrdinal, active, save, saving, error, sourceIndex, wrapped, toggleWrap],
  );

  return (
    <CodeEditContext.Provider value={codeEdit}>
      <MarkdownTextPrimitive
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        className={cn("font-reply text-prose break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0", className)}
      />
    </CodeEditContext.Provider>
  );
}

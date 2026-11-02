"use client";

import { useMemo, useState, type ComponentProps, type ElementType, type JSX } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { textPartIndex } from "@/lib/chat-parts";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "hast";
import { cn } from "@/lib/utils";
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
  h1: "mt-6 mb-3 text-xl font-semibold tracking-tight",
  h2: "mt-6 mb-3 text-lg font-semibold tracking-tight",
  h3: "mt-5 mb-2 text-base font-semibold",
  h4: "mt-4 mb-2 text-sm font-semibold",
  h5: "mt-4 mb-2 text-sm font-medium",
  h6: "mt-4 mb-2 text-sm font-medium text-muted-foreground",
  p: "my-3",
  ul: "my-3 list-disc pl-5 marker:text-muted-foreground [&_ol]:my-1 [&_ul]:my-1",
  ol: "my-3 list-decimal pl-5 marker:text-muted-foreground marker:tabular-nums [&_ol]:my-1 [&_ul]:my-1",
  li: "my-1 pl-1",
  blockquote: "my-3 border-l border-border-strong pl-4 text-muted-foreground",
  hr: "my-6 border-t",
  strong: "font-semibold text-foreground",
  code: "rounded-sm border bg-surface-sunken px-1 py-px font-mono text-[0.85em]",
  thead: "border-b border-border-strong",
  tr: "border-b last:border-b-0",
  th: "px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground",
  td: "px-3 py-2 align-top tabular-nums",
} as const satisfies Partial<Record<Tag, string>>;

const styledElements = Object.fromEntries(
  Object.entries(elementClasses).map(([tag, base]) => [tag, styled(tag as Tag, base)]),
);

function Link({ node: _node, className, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return (
    <a
      target="_blank"
      rel="noreferrer noopener"
      className={cn("text-foreground underline decoration-sun/50 underline-offset-2 hover:decoration-sun", className)}
      {...props}
    />
  );
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

const components = { ...styledElements, a: Link, table: Table, CodeHeader, SyntaxHighlighter };
const remarkPlugins = [remarkGfm];

function rehypeCodeBlocks() {
  return (tree: Root) => {
    let index = 0;
    function visit(node: Root | RootContent) {
      if (node.type === "element" && node.tagName === "pre") {
        const code = node.children.find((child) => child.type === "element" && child.tagName === "code");
        if (code?.type === "element") {
          code.properties["data-code-index"] = index++;
          if (code.position?.start.offset !== undefined) code.properties["data-code-fence"] = code.position.start.offset;
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}

const rehypePlugins = [rehypeCodeBlocks];

export function MarkdownText({ className, editable = false }: { className?: string; editable?: boolean }) {
  const aui = useAui();
  const chat = useAISDKChat();
  const partText = useAuiState((s) => (s.part.type === "text" ? s.part.text : ""));
  const textOrdinal = useAuiState((s) => {
    const query = aui.part.query;
    if (!query || !("index" in query) || typeof query.index !== "number") return undefined;
    return s.message.parts.slice(0, query.index).filter((part) => part.type === "text").length;
  });
  const messageId = useAuiState((s) => s.message.id);
  const sourceMessage = chat?.messages.find((message) => message.id === messageId);
  const sourceIndex = sourceMessage && textOrdinal !== undefined ? textPartIndex(sourceMessage.parts, textOrdinal) : undefined;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const [active, setActive] = useState<number | null>(null);
  const { save, saving, error } = useSaveMessageText();

  const codeEdit = useMemo(
    () => ({
      enabled: editable && Boolean(messageId) && !running,
      text: partText, textOrdinal, active, setActive, messageId, saving, error,
      save: (id: string, text: string) => {
        if (sourceIndex === undefined) return Promise.resolve(false);
        return save(id, text, sourceIndex);
      },
    }),
    [editable, messageId, running, partText, textOrdinal, active, save, saving, error, sourceIndex],
  );

  return (
    <CodeEditContext.Provider value={codeEdit}>
      <MarkdownTextPrimitive
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        className={cn("text-sm leading-6 break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0", className)}
      />
    </CodeEditContext.Provider>
  );
}

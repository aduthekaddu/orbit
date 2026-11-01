"use client";

import type { ComponentProps, ElementType, JSX } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { CodeHeader, SyntaxHighlighter } from "./code-block";

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

export function MarkdownText({ className }: { className?: string }) {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      components={components}
      className={cn("text-sm leading-6 break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0", className)}
    />
  );
}

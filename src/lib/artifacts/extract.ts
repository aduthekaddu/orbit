import type { Element, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { rehypeCodeBlocks } from "../markdown-code";
import { artifactKind, isArtifactLanguage, type ArtifactKind, type ArtifactLanguage } from "./detect";
import type { Redactor } from "../chat-errors";
import { maskedArtifactTitle } from "./title";

export type ExtractedArtifact = {
  /** 0-based index among the message's text parts. */
  textOrdinal: number;
  /** The `data-code-index` rehypeCodeBlocks gives the block, counting every rendered code block in the part. */
  blockIndex: number;
  /** 0-based index among the message's artifact blocks only. */
  artifactPosition: number;
  kind: ArtifactKind;
  language: ArtifactLanguage;
  code: string;
  derivedTitle: string;
};

// The chat renders a text part with react-markdown, which builds this processor with these remark-rehype options
// (createProcessor in node_modules/react-markdown/lib/index.js), and with the plugins in src/components/chat/markdown-text.tsx.
// Rendering moves footnote definitions to the end and drops unused ones, so blocks are numbered on the rendered tree.
const renderer = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeCodeBlocks);

function textOf(node: Element | RootContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}

/**
 * Each rendered `<pre><code>` block, read the way CodeHeader reads it: the `language-*` class and the element's text.
 * The parser and remark-rehype recurse once per nesting level, so text nested a few thousand quotes or lists deep
 * overflows the stack. The chat's renderer overflows on that text too and shows no card, so it holds no blocks here.
 */
function renderedBlocks(markdown: string) {
  const blocks: { index: number; language: string; code: string }[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "element" && node.tagName === "pre") {
      const code = node.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
      const index = code?.properties["data-code-index"];
      if (code && typeof index === "number") {
        const className = code.properties.className;
        const classes = Array.isArray(className) ? className.join(" ") : String(className ?? "");
        blocks.push({ index, language: /(?:^|\s)language-([^\s]+)/.exec(classes)?.[1] ?? "", code: textOf(code) });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  try {
    visit(renderer.runSync(renderer.parse(markdown)));
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
  return blocks;
}

/** The HTML, SVG, and React blocks of a message's parts, keyed the way the thread renders them, with masked titles. */
export function extractArtifacts(parts: unknown, redact: Redactor): ExtractedArtifact[] {
  if (!Array.isArray(parts)) return [];
  const found: ExtractedArtifact[] = [];
  let textOrdinal = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") continue;
    for (const block of renderedBlocks(text)) {
      if (!isArtifactLanguage(block.language)) continue;
      const kind = artifactKind(block.language)!;
      found.push({
        textOrdinal, blockIndex: block.index, artifactPosition: found.length,
        kind, language: block.language, code: block.code, derivedTitle: maskedArtifactTitle({ kind, code: block.code }, redact),
      });
    }
    textOrdinal++;
  }
  return found;
}

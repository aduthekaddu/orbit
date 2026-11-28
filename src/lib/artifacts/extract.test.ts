import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCodeBlocks } from "../markdown-code";
import { isArtifactLanguage } from "./detect";
import { Redactor } from "../chat-errors";
import { extractArtifacts } from "./extract";

const text = (value: string) => ({ type: "text", text: value });
const redact = new Redactor(null);

function slots(parts: unknown) {
  return extractArtifacts(parts, redact).map(({ textOrdinal, blockIndex, artifactPosition, kind, language }) => ({ textOrdinal, blockIndex, artifactPosition, kind, language }));
}

test("anything but a parts array holds no artifacts", () => {
  for (const parts of [null, undefined, "```html\n<p>a</p>\n```", { type: "text", text: "```html\n<p>a</p>\n```" }, 7]) {
    assert.deepEqual(extractArtifacts(parts, redact), []);
  }
});

test("only text parts with string text count toward textOrdinal", () => {
  const parts = [
    { type: "reasoning", text: "```html\n<p>thinking</p>\n```" },
    text("Intro"),
    { type: "tool-run_code", toolCallId: "run", state: "output-available", input: { code: "```html\n<p>tool</p>\n```" } },
    { type: "step-start" },
    { type: "data-card", data: { text: "```html\n<p>data</p>\n```" } },
    { type: "text", text: 42 },
    text("```html\n<h1>Second text part</h1>\n```"),
  ];
  assert.deepEqual(slots(parts), [{ textOrdinal: 1, blockIndex: 0, artifactPosition: 0, kind: "html", language: "html" }]);
});

test("every code block advances blockIndex, artifact or not", () => {
  const markdown = [
    "```python\nprint(1)\n```",
    "Intro paragraph.",
    "    indented = True",
    "```\nplain block\n```",
    "```HTML\n<p>upper case is not an artifact</p>\n```",
    "```html\n<p>page</p>\n```",
  ].join("\n\n");
  assert.deepEqual(slots([text(markdown)]), [{ textOrdinal: 0, blockIndex: 4, artifactPosition: 0, kind: "html", language: "html" }]);
});

test("a space before the tag, a longer fence, a tilde fence, and an info string after the tag all keep the language", () => {
  const markdown = ["``` html\n<p>a</p>\n```", "````html\n<p>b</p>\n````", "~~~svg\n<svg></svg>\n~~~", "```jsx title=\"App\"\nexport default function App() { return null; }\n```"].join("\n\n");
  assert.deepEqual(slots([text(markdown)]).map(({ blockIndex, kind, language }) => [blockIndex, kind, language]), [
    [0, "html", "html"], [1, "html", "html"], [2, "svg", "svg"], [3, "react", "jsx"],
  ]);
});

test("jsx and tsx blocks are React artifacts that keep their own language", () => {
  const markdown = "```tsx\nexport default function Typed(): null { return null; }\n```\n\n```jsx\nexport default function Plain() { return null; }\n```";
  assert.deepEqual(extractArtifacts([text(markdown)], redact).map(({ kind, language, derivedTitle }) => [kind, language, derivedTitle]), [
    ["react", "tsx", "Typed"],
    ["react", "jsx", "Plain"],
  ]);
});

test("artifactPosition counts artifacts across the whole message, blockIndex restarts in each text part", () => {
  const parts = [
    text("```python\nprint(1)\n```\n\n```html\n<p>one</p>\n```"),
    { type: "tool-run_code", toolCallId: "run" },
    text("```svg\n<svg></svg>\n```\n\n```tsx\nexport default function Two() { return null; }\n```"),
  ];
  assert.deepEqual(slots(parts).map(({ textOrdinal, blockIndex, artifactPosition }) => [textOrdinal, blockIndex, artifactPosition]), [
    [0, 1, 0], [1, 0, 1], [1, 1, 2],
  ]);
});

test("the code ends in one newline as the renderer shows it, and an empty block stays empty", () => {
  const codes = extractArtifacts([text("```html\n<h1>A</h1>\n```\n\n```html\n```\n\n```svg\n<svg></svg>\n\n\n```")], redact).map((artifact) => artifact.code);
  assert.deepEqual(codes, ["<h1>A</h1>\n", "", "<svg></svg>\n\n\n"]);
});

test("code blocks inside blockquotes and lists are artifacts too", () => {
  const markdown = "> ```html\n> <p>quoted</p>\n> ```\n\n- item\n\n  ```svg\n  <svg></svg>\n  ```";
  assert.deepEqual(extractArtifacts([text(markdown)], redact).map(({ blockIndex, kind, code }) => [blockIndex, kind, code]), [
    [0, "html", "<p>quoted</p>\n"],
    [1, "svg", "<svg></svg>\n"],
  ]);
});

test("each artifact carries the title read from its code, or the kind's fallback", () => {
  const markdown = "```html\n<title>Counter</title>\n```\n\n```html\n<p>no title</p>\n```\n\n```svg\n<svg></svg>\n```";
  assert.deepEqual(extractArtifacts([text(markdown)], redact).map((artifact) => artifact.derivedTitle), ["Counter", "HTML page", "SVG image"]);
});

test("a footnote definition moves to the end of the page, so the block after it keeps the renderer's number", () => {
  const markdown = "See note[^x].\n\n[^x]: Note.\n\n    ~~~python\n    print(1)\n    ~~~\n\n~~~html\n<h1>Hello</h1>\n~~~";
  assert.deepEqual(slots([text(markdown)]), [{ textOrdinal: 0, blockIndex: 0, artifactPosition: 0, kind: "html", language: "html" }]);
});

// The chat renders each text part with react-markdown, remark-gfm and rehypeCodeBlocks (src/components/chat/markdown-text.tsx),
// and CodeHeader reads the language from the `language-*` class and the code from the element's text.
function rendered(markdown: string) {
  const blocks: { blockIndex: number; language: string; code: string }[] = [];
  const components: Components = {
    code({ node, className, children }) {
      const index = node?.properties["data-code-index"];
      const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
      if (typeof index === "number" && isArtifactLanguage(language)) blocks.push({ blockIndex: index, language, code: String(children ?? "") });
      return null;
    },
  };
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeCodeBlocks], components, children: markdown }));
  return blocks.sort((a, b) => a.blockIndex - b.blockIndex);
}

test("extraction matches the chat renderer's block numbers, languages, and code byte for byte", () => {
  const corpus = [
    "```html\n<h1>A</h1>\n```",
    "```python\nprint(1)\n```\n\n```html\n<p>after python</p>\n```",
    "Intro\n\n    indented\n\n``` html\n<p>space</p>\n```",
    "~~~svg\n<svg></svg>\n~~~\n\n```HTML\n<p>upper</p>\n```\n\n```tsx\nexport default function T() { return null; }\n```",
    "> ```html\n> <p>quoted</p>\n> ```\n\n1. one\n\n   ```jsx\n   export default function J() { return null; }\n   ```",
    "```html\n```\n\n```svg\n<svg></svg>\n\n\n```\n\n```html\n<p>unclosed",
    "See note[^x].\n\n[^x]: Note.\n\n    ~~~python\n    print(1)\n    ~~~\n\n~~~html\n<h1>Hello</h1>\n~~~",
    "[^unused]: Dropped.\n\n    ```html\n    <p>never rendered</p>\n    ```\n\n```svg\n<svg><title>Kept</title></svg>\n```",
    "| a | b |\n| - | - |\n| `x` | y |\n\n<pre><code>raw html</code></pre>\n\n```html\n<p>after a table and raw html</p>\n```",
  ];
  for (const markdown of corpus) {
    const extracted = extractArtifacts([text(markdown)], redact).map(({ blockIndex, language, code }) => ({ blockIndex, language, code }));
    assert.deepEqual(extracted, rendered(markdown), markdown);
  }
});

test("a text part nested too deep to render holds no artifacts, the chat renders no card for it, and later parts keep their keys", () => {
  for (const depth of [3_500, 20_000]) {
    const deep = `${"> ".repeat(depth)}\`\`\`html\n<h1>Deep</h1>\n\`\`\``;
    assert.throws(() => rendered(deep), RangeError, `the chat renderer cannot render ${depth} nested quotes either`);
    assert.deepEqual(slots([text(deep), text("```html\n<h1>After</h1>\n```")]), [{ textOrdinal: 1, blockIndex: 0, artifactPosition: 0, kind: "html", language: "html" }], `${depth} nested quotes`);
  }
});

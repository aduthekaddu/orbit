import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";
import { codeBodyStart } from "./chat-parts";
import { rehypeCodeBlocks } from "./markdown-code";

test("a prose copy of the code body keeps the fence offset from the parsed block", () => {
  const markdown = "null\n\n```json\nnull\n```";
  let block: Element | undefined;
  const components: Components = {
    code({ node, children }) {
      block = node;
      return createElement("code", null, children);
    },
  };

  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeCodeBlocks],
      components,
      children: markdown,
    }),
  );

  assert.ok(block);
  const fenceOffset = block.properties["data-code-fence"];
  assert.equal(fenceOffset, 6);
  assert.equal(codeBodyStart(markdown, fenceOffset as number, "null\n"), 14);
});

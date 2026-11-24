import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { components } from "./markdown-text";

function renderMarkdown(text: string) {
  return renderToStaticMarkup(<Markdown components={components}>{text}</Markdown>);
}

test("markdown images render as links without loading images", () => {
  const markup = renderMarkdown("![x](https://example.invalid/p.png)");

  assert.doesNotMatch(markup, /<img\b|\bas="image"/);
  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.invalid\/p\.png"[^>]*>x<\/a>/);
  assert.match(markup, /\brel="noreferrer noopener"/);
});

test("markdown images without alt text use the URL as link text", () => {
  const markup = renderMarkdown("![](https://example.invalid/p.png)");

  assert.match(markup, /<a\b[^>]*>https:\/\/example\.invalid\/p\.png<\/a>/);
});

test("a markdown image inside a link keeps the outer link and its label", () => {
  const markup = renderMarkdown("[![x](https://example.invalid/p.png)](https://example.invalid/)");

  assert.doesNotMatch(markup, /<img\b|\bas="image"/);
  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.invalid\/"[^>]*>x<\/a>/);
});

test("a markdown image whose URL is stripped leaves its alt text", () => {
  const markup = renderMarkdown("![x](data:image/png;base64,eA==)");

  assert.doesNotMatch(markup, /<img\b|<a\b/);
  assert.match(markup, />x<\/p>/);
});

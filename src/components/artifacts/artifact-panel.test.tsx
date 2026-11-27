import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Artifact } from "@/lib/artifacts/detect";
import { ArtifactPanel } from "./artifact-panel";

function decode(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function codeTab(artifact: Artifact) {
  const markup = renderToStaticMarkup(<ArtifactPanel artifact={artifact} onClose={() => {}} onFix={() => {}} />);
  const panel = /<div[^>]*id="artifact-code"[^>]*>([\s\S]*)$/.exec(markup)?.[1] ?? "";
  const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(panel)?.[1];
  assert.ok(code !== undefined, "the Code tab has a <code> element");
  return { markup, code };
}

const SOURCES: [string, Artifact][] = [
  ["HTML with a trailing newline", { key: "a", kind: "html", language: "html", code: "<!doctype html>\n<title>Signup form</title>\n\n<h1 class=\"x\">Hi &amp; bye</h1>\n" }],
  ["HTML without a trailing newline", { key: "b", kind: "html", language: "html", code: "<h1>One</h1>\n<p>Two</p>" }],
  ["blank lines and CRLF line ends", { key: "c", kind: "html", language: "html", code: "<p>a</p>\r\n\r\n\n<p>b</p>\r\n" }],
  ["an SVG", { key: "d", kind: "svg", language: "svg", code: '<svg viewBox="0 0 2 2"><title>Dot</title><circle r="1"/></svg>' }],
  ["a TSX component", { key: "e", kind: "react", language: "tsx", code: "type Label = string;\nexport default function Typed() {\n  const label: Label = 'Typed';\n  return <button>{label}</button>;\n}\n" }],
];

for (const [name, artifact] of SOURCES) {
  test(`the Code tab text equals the artifact source for ${name}`, () => {
    const { code } = codeTab(artifact);
    assert.equal(decode(code), artifact.code);
  });
}

test("the Code tab highlights the source with Prism token spans", () => {
  const { code } = codeTab(SOURCES[0][1]);
  assert.match(code, /<span[^>]*class="token[^"]*tag/);
  assert.match(code, /<span[^>]*class="token[^"]*attr-value/);
  const tsx = codeTab(SOURCES[4][1]).code;
  assert.match(tsx, /<span[^>]*class="token[^"]*keyword/);
});

test("the panel header shows the artifact title", () => {
  const { markup } = codeTab(SOURCES[0][1]);
  assert.match(markup, /<h2[^>]*>Signup form<\/h2>/);
  assert.match(codeTab(SOURCES[4][1]).markup, /<h2[^>]*>Typed<\/h2>/);
});

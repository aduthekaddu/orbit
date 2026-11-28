import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { Artifact } from "@/lib/artifacts/detect";
import type { ArtifactVersionSummary } from "@/lib/artifacts/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtifactDiff, rememberArtifactCode } from "./artifact-diff";
import { ArtifactPanel, renameRequest } from "./artifact-panel";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };

function paint(element: ReactElement) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <TooltipProvider>{element}</TooltipProvider>
    </AppRouterContext.Provider>,
  );
}

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

/** Every button's accessible name: its aria-label, else its text. */
function buttonNames(markup: string) {
  return [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, body]) => {
    const label = /aria-label="([^"]*)"/.exec(attributes)?.[1];
    return label ?? decode(body).trim();
  });
}

function tabs(markup: string) {
  return [...markup.matchAll(/<button([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, body]) => ({
    name: decode(body).trim(),
    selected: /aria-selected="true"/.test(attributes),
    tabIndex: /tabindex="(-?\d+)"/.exec(attributes)?.[1],
    controls: /aria-controls="([^"]*)"/.exec(attributes)?.[1],
  }));
}

function codeTab(artifact: Artifact) {
  const markup = paint(<ArtifactPanel artifact={artifact} onClose={() => {}} onFix={() => {}} />);
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
  assert.match(code, /<span class="token tag" style="color:var\(--syntax-function\)">title<\/span>/, "tag names are colored");
  const tsx = codeTab(SOURCES[4][1]).code;
  assert.match(tsx, /<span[^>]*class="token[^"]*keyword/);
});

test("the panel header shows the artifact title", () => {
  const { markup } = codeTab(SOURCES[0][1]);
  assert.match(markup, /<h2[^>]*>Signup form<\/h2>/);
  assert.match(codeTab(SOURCES[4][1]).markup, /<h2[^>]*>Typed<\/h2>/);
});

function counter(number: number) {
  return `<!doctype html>\n<title>Counter</title>\n<h1>Counter</h1>\n<p>Version ${number}</p>\n`;
}

function versions(prefix: string, count: number): ArtifactVersionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-v${index + 1}`,
    number: index + 1,
    messageId: `${prefix}-m${index + 1}`,
    key: `${prefix}-m${index + 1}.0.0`,
    language: "html",
    derivedTitle: "Counter",
    createdAt: `2026-11-0${index + 1}T10:00:00.000Z`,
    updatedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
  }));
}

function storedAt(list: ArtifactVersionSummary[], number: number, userTitle: string | null = null) {
  const version = list[number - 1];
  return { id: version.id, lineageId: list[0].id, title: userTitle ?? "Counter", derivedTitle: "Counter", userTitle, number, versions: list };
}

function artifactAt(list: ArtifactVersionSummary[], number: number): Artifact {
  return { key: list[number - 1].key, kind: "html", language: "html", code: counter(number) };
}

const THREE = versions("three", 3);

test("a renamed artifact shows its own title in the header, with a Rename button", () => {
  const markup = paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} stored={storedAt(THREE, 3, "Tally")} onClose={() => {}} />);
  assert.match(markup, /<h2[^>]*>Tally<\/h2>/);
  assert.ok(buttonNames(markup).includes("Rename artifact"));
});

test("an artifact with no saved row cannot be renamed", () => {
  const markup = paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} onClose={() => {}} />);
  assert.match(markup, /<h2[^>]*>Counter<\/h2>/);
  assert.ok(!buttonNames(markup).includes("Rename artifact"));
});

test("a lineage with several versions shows every version and marks the open one", () => {
  const markup = paint(<ArtifactPanel artifact={artifactAt(THREE, 2)} stored={storedAt(THREE, 2)} onClose={() => {}} />);
  const strip = /<div[^>]*role="group"[^>]*aria-label="Versions"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1];
  assert.ok(strip, "the versions strip is on screen");
  assert.deepEqual(buttonNames(strip), ["v1", "v2", "v3"]);
  assert.match(strip, /<button[^>]*aria-current="true"[^>]*>v2<\/button>/);
  assert.doesNotMatch(strip, /<button[^>]*aria-current="true"[^>]*>v1<\/button>/);
  assert.doesNotMatch(strip, /<button[^>]*aria-current="true"[^>]*>v3<\/button>/);
});

test("several versions add a Diff tab after Preview and Code, with one tab stop", () => {
  const markup = paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} stored={storedAt(THREE, 3)} onClose={() => {}} />);
  assert.deepEqual(tabs(markup), [
    { name: "Preview", selected: true, tabIndex: "0", controls: "artifact-preview" },
    { name: "Code", selected: false, tabIndex: "-1", controls: "artifact-code" },
    { name: "Diff", selected: false, tabIndex: "-1", controls: "artifact-diff" },
  ]);
  assert.match(markup, /<div[^>]*role="tabpanel"[^>]*id="artifact-diff"/);
});

test("a single version shows no version strip and no Diff tab", () => {
  const one = versions("one", 1);
  const markup = paint(<ArtifactPanel artifact={artifactAt(one, 1)} stored={storedAt(one, 1)} onClose={() => {}} />);
  assert.doesNotMatch(markup, /aria-label="Versions"/);
  assert.ok(!buttonNames(markup).includes("v1"));
  assert.deepEqual(tabs(markup).map((tab) => tab.name), ["Preview", "Code"]);
});

test("the chat panel can close, and the library panel links to the chat and goes back instead", () => {
  const chat = paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} stored={storedAt(THREE, 3)} onClose={() => {}} onFix={() => {}} />);
  assert.ok(buttonNames(chat).includes("Close"));
  assert.ok(!buttonNames(chat).includes("Back"));
  assert.doesNotMatch(chat, />Open in chat</);

  const href = "/c/chat-1?m=three-m3&artifact=three-m3.0.0";
  const library = paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} stored={storedAt(THREE, 3)} openInChatHref={href} onBack={() => {}} />);
  assert.ok(!buttonNames(library).includes("Close"));
  assert.ok(buttonNames(library).includes("Back"));
  assert.match(library, /<a[^>]*href="\/c\/chat-1\?m=three-m3&amp;artifact=three-m3\.0\.0"[^>]*>Open in chat<\/a>/);
});

test("Reload, Copy, and Download stay in the panel", () => {
  const names = buttonNames(paint(<ArtifactPanel artifact={artifactAt(THREE, 3)} stored={storedAt(THREE, 3)} onClose={() => {}} />));
  for (const name of ["Reload", "Copy", "Download"]) assert.ok(names.includes(name), `${name} is a button`);
});

test("a rename sends the tidied title, a blank title clears a rename, and nothing new sends nothing", () => {
  const derived = { title: "Counter", userTitle: null };
  const renamed = { title: "Tally", userTitle: "Tally" };
  assert.equal(renameRequest(derived, "Tally"), "Tally");
  assert.equal(renameRequest(derived, "  Quarterly \t  report "), "Quarterly report");
  assert.equal(renameRequest(derived, "Counter"), null);
  assert.equal(renameRequest(derived, "  Counter "), null);
  assert.equal(renameRequest(derived, "   "), null, "a blank title on an unrenamed artifact changes nothing");
  assert.equal(renameRequest(renamed, ""), "", "a blank title resets to the derived title");
  assert.equal(renameRequest(renamed, " "), "");
  assert.equal(renameRequest(renamed, "Counter"), "Counter");
  assert.equal(renameRequest(renamed, "Tally"), null);
});

function rows(markup: string) {
  return [...markup.matchAll(/<div[^>]*data-diff-line="(context|added|removed)"[^>]*>([\s\S]*?)<\/div>/g)].map(([, kind, body]) => `${kind}:${decode(body).replace(/^\s*\d*\s*\d*\s*[+-]?\s*/, "")}`);
}

test("Diff compares the open version with the one before it", () => {
  const list = versions("before", 3);
  rememberArtifactCode(list[1].id, list[1].updatedAt, counter(2));
  const markup = paint(<ArtifactDiff current={{ id: list[2].id, code: counter(3) }} versions={list} />);
  assert.match(markup, /<button[^>]*role="combobox"[^>]*aria-label="Compare with"[^>]*><span[^>]*>v2<\/span>/);
  assert.deepEqual(rows(markup).filter((row) => !row.startsWith("context")), ["removed:<p>Version 2</p>", "added:<p>Version 3</p>"]);
  assert.match(markup, />\+1<\/span>/, "one added line");
  assert.match(markup, />-1<\/span>/, "one removed line");
});

test("Diff on the first version compares it with the second, oldest first", () => {
  const list = versions("first", 3);
  rememberArtifactCode(list[1].id, list[1].updatedAt, counter(2));
  const markup = paint(<ArtifactDiff current={{ id: list[0].id, code: counter(1) }} versions={list} />);
  assert.match(markup, /aria-label="Compare with"[^>]*><span[^>]*>v2<\/span>/);
  assert.deepEqual(rows(markup).filter((row) => !row.startsWith("context")), ["removed:<p>Version 1</p>", "added:<p>Version 2</p>"]);
});

test("Diff folds a long unchanged run behind a button that opens it in place", () => {
  const list = versions("fold", 2);
  const middle = Array.from({ length: 20 }, (_, index) => `<li>${index + 1}</li>`).join("\n");
  rememberArtifactCode(list[0].id, list[0].updatedAt, `<h1>Old</h1>\n${middle}\n<p>End</p>\n`);
  const markup = paint(<ArtifactDiff current={{ id: list[1].id, code: `<h1>New</h1>\n${middle}\n<p>Finish</p>\n` }} versions={list} />);
  const fold = /<button[^>]*aria-expanded="false"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
  assert.ok(fold, "the unchanged run is a collapsed button");
  assert.match(decode(fold[1]), /14\s*unchanged lines/);
  assert.doesNotMatch(decode(markup), /<li>10<\/li>/, "folded lines stay out of view");
  assert.match(decode(markup), /<li>3<\/li>/, "three context lines stay after a change");
});

test("Diff says when two versions match", () => {
  const list = versions("same", 2);
  rememberArtifactCode(list[0].id, list[0].updatedAt, counter(1));
  const markup = paint(<ArtifactDiff current={{ id: list[1].id, code: counter(1) }} versions={list} />);
  assert.match(decode(markup), /No differences/);
  assert.deepEqual(rows(markup), []);
});

test("Diff waits for a version it has not loaded yet", () => {
  const list = versions("wait", 2);
  const markup = paint(<ArtifactDiff current={{ id: list[1].id, code: counter(2) }} versions={list} />);
  assert.match(markup, /role="status"[^>]*>Loading version</);
  assert.deepEqual(rows(markup), []);
});

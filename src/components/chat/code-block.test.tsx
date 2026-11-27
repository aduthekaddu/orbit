import assert from "node:assert/strict";
import { test } from "node:test";
import type { Element } from "hast";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactContext } from "@/components/artifacts/use-artifact";
import { ArtifactCard } from "./artifact-card";
import { CodeHeader, SyntaxHighlighter } from "./code-block";
import { CodeEditContext, type CodeEditContextValue } from "./code-edit-context";

const PYTHON = "print('a very long line of python that does not fit')\n";

function node(index: number) {
  return { type: "element", tagName: "code", properties: { "data-code-index": index, "data-code-fence": 0 }, children: [] } as unknown as Element;
}

function context(overrides: Partial<CodeEditContextValue> = {}): CodeEditContextValue {
  return {
    enabled: true,
    text: "```python\n" + PYTHON + "```",
    textOrdinal: 0,
    active: null,
    setActive: () => {},
    save: async () => true,
    messageId: "m1",
    saving: false,
    error: "",
    streaming: false,
    wrapped: new Set<number>(),
    toggleWrap: () => {},
    ...overrides,
  };
}

function renderBlock(value: CodeEditContextValue) {
  const components = { Pre: "pre", Code: "code" } as never;
  return renderToStaticMarkup(
    <CodeEditContext.Provider value={value}>
      <CodeHeader language="python" code={PYTHON} node={node(0)} />
      <SyntaxHighlighter language="python" code={PYTHON} node={node(0)} components={components} />
    </CodeEditContext.Provider>,
  );
}

function preClass(markup: string) {
  return /<pre class="([^"]*)"/.exec(markup)?.[1] ?? "";
}

test("a plain code block has a Wrap toggle that starts off", () => {
  const markup = renderBlock(context());
  assert.match(markup, /<button[^>]*aria-pressed="false"[^>]*>Wrap<\/button>/);
  assert.match(preClass(markup), /\bw-max\b/);
  assert.doesNotMatch(preClass(markup), /whitespace-pre-wrap/);
});

test("a wrapped code block wraps its lines and marks the toggle pressed", () => {
  const markup = renderBlock(context({ wrapped: new Set([0]) }));
  assert.match(markup, /<button[^>]*aria-pressed="true"[^>]*>Wrap<\/button>/);
  assert.doesNotMatch(preClass(markup), /\bw-max\b/);
  assert.match(preClass(markup), /\bw-full\b/);
  assert.match(preClass(markup), /\bwhitespace-pre-wrap\b/);
  assert.match(preClass(markup), /\bbreak-words\b/);
});

test("wrap state belongs to one block", () => {
  const markup = renderBlock(context({ wrapped: new Set([1]) }));
  assert.match(markup, /aria-pressed="false"/);
  assert.match(preClass(markup), /\bw-max\b/);
});

test("an artifact card shows its title, type, and an Open button named for the title", () => {
  const markup = renderToStaticMarkup(<ArtifactCard kind="html" title="Signup form" streaming={false} onOpen={() => {}} onEdit={() => {}} />);
  assert.match(markup, /data-artifact-card=""/);
  assert.doesNotMatch(markup, /data-streaming/);
  assert.match(markup, />Signup form</);
  assert.match(markup, />HTML</);
  const open = /<button[^>]*aria-label="Open Signup form"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
  assert.ok(open, "the Open button is named for the title");
  assert.doesNotMatch(open[0], /\sdisabled=""/);
  assert.match(open[1], /Open/);
  assert.match(markup, /<button[^>]*aria-label="Edit code"/);
});

test("an artifact card has no Edit button when editing is not allowed, and Open still works", () => {
  const markup = renderToStaticMarkup(<ArtifactCard kind="svg" title="Logo" streaming={false} onOpen={() => {}} />);
  assert.doesNotMatch(markup, /aria-label="Edit code"/);
  assert.match(markup, />SVG</);
  const open = /<button[^>]*aria-label="Open Logo"[^>]*>/.exec(markup);
  assert.ok(open);
  assert.doesNotMatch(open[0], /\sdisabled=""/);
});

test("a streaming artifact card is marked busy and its Open button waits", () => {
  const markup = renderToStaticMarkup(<ArtifactCard kind="react" title="Counter" streaming onOpen={() => {}} />);
  assert.match(markup, /data-streaming="true"/);
  assert.match(markup, />React</);
  const open = /<button[^>]*aria-label="Open Counter"[^>]*>/.exec(markup);
  assert.ok(open);
  assert.match(open[0], /\sdisabled=""/);
  assert.match(markup, /animate-orbit/, "the busy orbit mark replaces the kind icon");
});

const FORM = "<!doctype html>\n<title>Signup form</title>\n<form><input name=\"email\"><button>Join</button></form>\n";

function renderArtifact(value: CodeEditContextValue, language = "html", code = FORM) {
  const components = { Pre: "pre", Code: "code" } as never;
  const artifacts = { artifact: undefined, register: () => () => {}, open: () => {}, close: () => {} };
  return renderToStaticMarkup(
    <ArtifactContext.Provider value={artifacts}>
      <CodeEditContext.Provider value={value}>
        <CodeHeader language={language} code={code} node={node(0)} />
        <SyntaxHighlighter language={language} code={code} node={node(0)} components={components} />
      </CodeEditContext.Provider>
    </ArtifactContext.Provider>,
  );
}

function artifactContext(overrides: Partial<CodeEditContextValue> = {}) {
  return context({ text: "```html\n" + FORM + "```", ...overrides });
}

test("an artifact block in a reply shows a card instead of its code", () => {
  const markup = renderArtifact(artifactContext());
  assert.match(markup, /data-artifact-card=""/);
  assert.match(markup, />Signup form</);
  assert.match(markup, />HTML</);
  assert.match(markup, /<button[^>]*aria-label="Open Signup form"/);
  assert.match(markup, /<button[^>]*aria-label="Edit code"/);
  assert.doesNotMatch(markup, /<pre\b/, "the raw code is not in the thread");
  assert.doesNotMatch(markup, /&lt;form&gt;|<form/);
  assert.doesNotMatch(markup, />Wrap</, "an artifact card has no Wrap toggle");
});

test("a streaming artifact card is busy and Open waits for the reply", () => {
  const markup = renderArtifact(artifactContext({ enabled: false, streaming: true }));
  assert.match(markup, /data-streaming="true"/);
  assert.match(/<button[^>]*aria-label="Open Signup form"[^>]*>/.exec(markup)?.[0] ?? "", /\sdisabled=""/);
  assert.doesNotMatch(markup, /<pre\b/);
});

test("a read-only artifact card can still open, without Edit", () => {
  const markup = renderArtifact(artifactContext({ enabled: false }));
  const open = /<button[^>]*aria-label="Open Signup form"[^>]*>/.exec(markup)?.[0];
  assert.ok(open);
  assert.doesNotMatch(open, /\sdisabled=""/);
  assert.doesNotMatch(markup, /aria-label="Edit code"/);
});

test("an artifact block being edited shows the editor instead of the card", () => {
  const start = ("```html\n").length;
  const markup = renderArtifact(artifactContext({ active: start }));
  assert.doesNotMatch(markup, /data-artifact-card/);
  assert.match(markup, /<textarea[^>]*aria-label="Edit html block"/);
});

test("code blocks inside reasoning stay plain code blocks with no card", () => {
  const markup = renderArtifact(artifactContext({ enabled: false, textOrdinal: undefined }));
  assert.doesNotMatch(markup, /data-artifact-card/);
  assert.doesNotMatch(markup, /aria-label="Open /);
  assert.match(markup, /<pre\b/);
  assert.match(markup, />Wrap</);
});

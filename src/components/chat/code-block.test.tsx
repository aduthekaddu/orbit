import assert from "node:assert/strict";
import { test } from "node:test";
import type { Element } from "hast";
import { renderToStaticMarkup } from "react-dom/server";
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
  assert.doesNotMatch(open[0], /\bdisabled\b/);
  assert.match(open[1], /Open/);
  assert.match(markup, /<button[^>]*aria-label="Edit code"/);
});

test("an artifact card has no Edit button when editing is not allowed, and Open still works", () => {
  const markup = renderToStaticMarkup(<ArtifactCard kind="svg" title="Logo" streaming={false} onOpen={() => {}} />);
  assert.doesNotMatch(markup, /aria-label="Edit code"/);
  assert.match(markup, />SVG</);
  const open = /<button[^>]*aria-label="Open Logo"[^>]*>/.exec(markup);
  assert.ok(open);
  assert.doesNotMatch(open[0], /\bdisabled\b/);
});

test("a streaming artifact card is marked busy and its Open button waits", () => {
  const markup = renderToStaticMarkup(<ArtifactCard kind="react" title="Counter" streaming onOpen={() => {}} />);
  assert.match(markup, /data-streaming="true"/);
  assert.match(markup, />React</);
  const open = /<button[^>]*aria-label="Open Counter"[^>]*>/.exec(markup);
  assert.ok(open);
  assert.match(open[0], /\bdisabled\b/);
  assert.match(markup, /animate-orbit/, "the busy orbit mark replaces the kind icon");
});

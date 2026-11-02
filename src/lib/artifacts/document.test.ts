import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { artifactKind } from "./detect";
import { artifactDocument } from "./document";

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'";

for (const kind of ["html", "svg", "react"] as const) {
  test(`${kind} document applies the exact content security policy before model code`, () => {
    const code = kind === "react" ? 'export default function Page() { return "Artifact body"; }' : "<h1>Artifact body</h1>";
    const document = artifactDocument(kind, code);
    assert.ok(document.includes(`http-equiv="Content-Security-Policy" content="${CSP}"`));
    assert.ok(document.indexOf(CSP) < document.indexOf("Artifact body"));
  });
}

test("React imports pin every supported module to React 19.3.1", () => {
  const document = artifactDocument("react", "export default function Page() { return null; }");
  const raw = /<script type="importmap">([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(raw, "the document has an import map");
  const { imports } = JSON.parse(raw);
  for (const module of ["react", "react/jsx-runtime", "react-dom/client"]) {
    assert.match(imports[module], /^https:\/\/esm\.sh\//);
    assert.match(imports[module], /@19\.3\.1(?:\/|\?|$)/);
  }
});

test("an anonymous default component becomes the component rendered in the frame", () => {
  const document = artifactDocument("react", 'export default () => "Anonymous artifact";');
  assert.ok(document.includes("Anonymous artifact"));
  assert.doesNotMatch(document, /export\s+default/);
  assert.match(document, /createElement\(/);
  assert.match(document, /\.render\(/);
});

test("only supported fenced code languages are artifacts", () => {
  assert.equal(artifactKind("html"), "html");
  assert.equal(artifactKind("svg"), "svg");
  assert.equal(artifactKind("jsx"), "react");
  assert.equal(artifactKind("tsx"), "react");
  assert.equal(artifactKind("python"), undefined);
});

test("React default export handling preserves regexes, strings, and named function references", () => {
  const code = 'const pattern = /export default/; const label = "export default"; export default function Page() { return Page.name + label + pattern.source; }';
  const document = artifactDocument("react", code);
  assert.ok(document.includes('const pattern = /export default/;'));
  assert.ok(document.includes('"export default"'));
  assert.ok(document.includes('function Page()'));
  assert.ok(document.includes('Page.name'));
});

test("Escape inside the frame asks the app to close the preview", () => {
  const document = artifactDocument("html", "<h1>Page</h1>");
  const script = /<script>([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(script);
  const handlers = new Map<string, (event: { key: string }) => void>();
  const messages: unknown[] = [];
  runInNewContext(script, {
    addEventListener: (name: string, listener: (event: { key: string }) => void) => handlers.set(name, listener),
    parent: { postMessage: (message: unknown) => messages.push(message) },
  });
  handlers.get("keydown")?.({ key: "Enter" });
  assert.equal(messages.length, 0);
  handlers.get("keydown")?.({ key: "Escape" });
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: "orbit-artifact-close" }]));
});

test("the error bridge does not reserve names in the artifact's global scope", () => {
  const document = artifactDocument("html", "<h1>Page</h1>");
  const script = /<script>([\s\S]*?)<\/script>/.exec(document)?.[1];
  assert.ok(script);
  const context = { addEventListener: () => {}, parent: { postMessage: () => {} } };
  runInNewContext(script, context);
  assert.doesNotThrow(() => runInNewContext("const report = () => 'User report'; report();", context));
});

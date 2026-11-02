import assert from "node:assert/strict";
import { test } from "node:test";
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

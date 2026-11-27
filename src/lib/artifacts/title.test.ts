import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactKind, ArtifactLanguage } from "./detect";
import { ARTIFACT_KIND_LABEL, artifactFileName, artifactTitle } from "./title";

const LANGUAGE: Record<ArtifactKind, ArtifactLanguage> = { html: "html", svg: "svg", react: "jsx" };

function title(kind: ArtifactKind, code: string) {
  return artifactTitle({ kind, code });
}

function fileName(kind: ArtifactKind, code: string, language: ArtifactLanguage = LANGUAGE[kind]) {
  return artifactFileName({ kind, language, code });
}

test("each artifact kind has a short type label", () => {
  assert.deepEqual(ARTIFACT_KIND_LABEL, { html: "HTML", svg: "SVG", react: "React" });
});

test("an HTML title comes from <title> before any heading", () => {
  const code = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Signup form</title></head><body><h1>Join us</h1></body></html>";
  assert.equal(title("html", code), "Signup form");
  assert.equal(fileName("html", code), "signup-form.html");
});

test("an HTML page without <title> takes its first <h1>, with inner tags stripped", () => {
  assert.equal(title("html", '<main><h1 class="hero">Budget <em>tracker</em></h1><h1>Second</h1></main>'), "Budget tracker");
});

test("an HTML page without <title> or <h1> takes its first <h2>", () => {
  assert.equal(title("html", "<section><p>Intro</p><h2>Monthly report</h2><h2>Later</h2></section>"), "Monthly report");
});

test("an <h1> names the page even when an <h2> comes first", () => {
  assert.equal(title("html", "<h2>Step one</h2><h1>Setup guide</h1>"), "Setup guide");
});

test("a <title> inside an inline SVG does not name an HTML page", () => {
  assert.equal(title("html", '<svg viewBox="0 0 8 8"><title>Menu</title></svg><h1>Dashboard</h1>'), "Dashboard");
});

test("tag names match whole words and any letter case", () => {
  assert.equal(title("html", "<TITLE>Upper case</TITLE>"), "Upper case");
  assert.equal(title("html", "<titles>Not a title</titles><header>Top</header><h1>Real</h1>"), "Real");
  assert.equal(title("html", "<p>İİİİ</p><title>İstanbul guide</title>"), "İstanbul guide");
});

test("an SVG title comes from its <title>", () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><title>Artifact SVG</title><rect width="400" height="200"/></svg>';
  assert.equal(title("svg", code), "Artifact SVG");
  assert.equal(fileName("svg", code), "artifact-svg.svg");
});

test("an SVG ignores headings in foreign content", () => {
  assert.equal(title("svg", "<svg><foreignObject><h1>Heading</h1></foreignObject></svg>"), "SVG image");
});

test("a React title is the name of its default export", () => {
  assert.equal(title("react", "export default function SignupForm() { return <form />; }"), "SignupForm");
  assert.equal(title("react", "export default async function Loader() { return null; }"), "Loader");
  assert.equal(title("react", "export default class Board extends React.Component { render() { return null; } }"), "Board");
  assert.equal(title("react", "function Counter() { return null; }\nexport default Counter;"), "Counter");
  assert.equal(title("react", "const App = () => null;\nexport default App"), "App");
});

test("React title extraction handles generator declarations and standalone names", () => {
  assert.equal(title("react", "export default function* Carousel() { yield <div />; }"), "Carousel");
  assert.equal(title("react", "export default async function* Pages() { yield null; }"), "Pages");
  assert.equal(title("react", "const Board = () => null;\nexport default Board  ;  \n"), "Board");
  assert.equal(title("react", "export default Board.render();"), "React component");
});

test("a React component without a named default export falls back", () => {
  assert.equal(title("react", "export default () => <button>Count</button>;"), "React component");
  assert.equal(title("react", "export default function () { return null; }"), "React component");
  assert.equal(title("react", "export default memo(Counter);"), "React component");
  assert.equal(title("react", "export default null;"), "React component");
  assert.equal(title("react", "const Page = () => null;"), "React component");
});

test("titles decode entities once, with &amp; last", () => {
  assert.equal(
    title("html", "<title>Q&amp;A &lt;draft&gt; &quot;one&quot; &#39;two&#39; &#x27;three&#x27; &apos;four&apos;</title>"),
    "Q&A <draft> \"one\" 'two' 'three' 'four'",
  );
  assert.equal(title("html", "<title>&amp;lt;b&amp;gt; stays text</title>"), "&lt;b&gt; stays text");
  assert.equal(title("html", "<h1>&lt;b&gt;Not bold&lt;/b&gt;</h1>"), "<b>Not bold</b>");
});

test("titles collapse whitespace and trim", () => {
  assert.equal(title("html", "<title>\n   Signup \t\n\n  form   </title>"), "Signup form");
});

test("titles stop at 80 characters", () => {
  const long = "Quarterly planning dashboard for the whole engineering organization and every team in it";
  assert.ok(long.length > 80);
  const result = title("html", `<title>${long}</title>`);
  assert.equal(result, long.slice(0, 80).trimEnd());
  assert.ok(result.length <= 80);
  const astral = "𝒜".repeat(100);
  assert.equal(title("html", `<title>${astral}</title>`), "𝒜".repeat(80));
});

test("an empty or tag-only title falls back to the kind name", () => {
  assert.equal(title("html", ""), "HTML page");
  assert.equal(title("html", "<title> <b> </b> </title><p>No heading</p>"), "HTML page");
  assert.equal(title("svg", '<svg viewBox="0 0 1 1"><rect/></svg>'), "SVG image");
  assert.equal(title("react", ""), "React component");
});

test("an unclosed title or heading falls back instead of reading the rest of the page", () => {
  assert.equal(title("html", "<title>Never closed<body><p>Text</p>"), "HTML page");
});

test("file names are lowercase title slugs with the artifact language", () => {
  assert.equal(fileName("html", "<title>  -- Hello, World! --</title>"), "hello-world.html");
  assert.equal(fileName("react", "export default function Typed() { return null; }", "tsx"), "typed.tsx");
  assert.equal(fileName("react", "export default () => null;", "jsx"), "react-component.jsx");
  assert.equal(fileName("html", "<h1>Q&amp;A board</h1>"), "q-a-board.html");
});

test("file names keep letters and digits from any script", () => {
  assert.equal(fileName("html", "<title>Привет, мир 2026</title>"), "привет-мир-2026.html");
  assert.equal(fileName("html", "<title>東京の天気</title>"), "東京の天気.html");
  assert.equal(fileName("html", "<title>Café über straße</title>"), "café-über-straße.html");
});

test("a title with no letters or digits names the file artifact", () => {
  assert.equal(fileName("html", "<title>!!! ???</title>"), "artifact.html");
  assert.equal(fileName("svg", "<svg><title>🚀 🚀</title></svg>"), "artifact.svg");
});

test("file name slugs stop at 60 characters without a trailing dash", () => {
  const code = `<title>${"a".repeat(59)} ${"b".repeat(30)}</title>`;
  assert.equal(fileName("html", code), `${"a".repeat(59)}.html`);
  const exact = fileName("html", `<title>${"c".repeat(70)}</title>`);
  assert.equal(exact, `${"c".repeat(60)}.html`);
});

test("one 50,000-character run of a single letter is read quickly", () => {
  const run = "a".repeat(50_000);
  const inputs: [ArtifactKind, string][] = [
    ["html", run],
    ["html", `<title>${run}</title>`],
    ["html", `<h1>${run}`],
    ["html", `<title ${run}`],
    ["svg", `<svg><title>${run}</title></svg>`],
    ["react", run],
    ["react", `export default ${run.toUpperCase()}`],
    ["react", `export default function ${run}(`],
  ];
  const started = performance.now();
  for (const [kind, code] of inputs) {
    const name = title(kind, code);
    assert.ok(name.length <= 80, `${kind} title is capped`);
    const file = fileName(kind, code);
    assert.ok(file.length <= 60 + ".html".length, `${kind} file name is capped`);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `reading ${inputs.length} long inputs took ${Math.round(elapsed)} ms`);
  assert.equal(title("html", `<title>${run}</title>`), "a".repeat(80));
  assert.equal(fileName("html", `<title>${run}</title>`), `${"a".repeat(60)}.html`);
});

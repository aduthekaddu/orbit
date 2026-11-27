import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { artifactKind } from "./detect";
import { artifactDocument, type ArtifactTheme } from "./document";

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

const LIGHT: ArtifactTheme = {
  scheme: "light",
  background: "rgb(247, 246, 242)",
  surface: "rgb(253, 253, 251)",
  foreground: "rgb(28, 29, 33)",
  muted: "rgb(99, 100, 107)",
  border: "rgb(226, 224, 217)",
  accent: "rgb(200, 90, 28)",
  ring: "rgb(200, 90, 28)",
  radius: "10px",
};

const DARK: ArtifactTheme = { ...LIGHT, scheme: "dark", background: "rgb(11, 12, 15)", foreground: "rgb(236, 235, 230)" };

function styleBlocks(document: string) {
  return [...document.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

for (const kind of ["html", "svg", "react"] as const) {
  test(`${kind} document has one orbit-base style between the head meta tags and the error bridge`, () => {
    const code = kind === "react" ? "export default function Page() { return null; }" : "<h1>Styled</h1>";
    const document = artifactDocument(kind, code, DARK);
    const styles = styleBlocks(document);
    assert.equal(styles.length, 1);
    const style = document.indexOf("<style>");
    assert.ok(document.indexOf(CSP) < style, "the style follows the content security policy");
    assert.ok(document.indexOf('name="viewport"') < style, "the style follows the viewport meta tag");
    assert.ok(style < document.indexOf("<script>"), "the style comes before the error bridge");
    assert.ok(style < document.indexOf("<body>"), "the style comes before the body");
    assert.match(styles[0].trim(), /^@layer orbit-base \{[\s\S]*\}$/, "every rule sits in the orbit-base layer");
    let depth = 0;
    let closedAt = -1;
    const css = styles[0].trim();
    for (let index = 0; index < css.length; index++) {
      if (css[index] === "{") depth++;
      if (css[index] === "}" && --depth === 0) { closedAt = index; break; }
    }
    assert.equal(closedAt, css.length - 1, "nothing follows the orbit-base layer");
  });
}

test("the stylesheet paints the page with the theme it was given", () => {
  const light = styleBlocks(artifactDocument("html", "<p>Light</p>", LIGHT))[0];
  assert.match(light, /color-scheme:\s*light;/);
  assert.match(light, /--background:\s*rgb\(247, 246, 242\);/);
  assert.match(light, /--foreground:\s*rgb\(28, 29, 33\);/);
  assert.match(light, /--radius:\s*10px;/);
  assert.match(light, /background(?:-color)?:\s*var\(--background\)/);
  assert.match(light, /border-radius:\s*var\(--radius\)/);
  assert.match(light, /outline:[^;]*var\(--ring\)/);
  const dark = styleBlocks(artifactDocument("html", "<p>Dark</p>", DARK))[0];
  assert.match(dark, /color-scheme:\s*dark;/);
  assert.match(dark, /--background:\s*rgb\(11, 12, 15\);/);
});

test("the stylesheet uses the system font stack because the frame cannot load Geist", () => {
  const css = styleBlocks(artifactDocument("html", "<p>Text</p>", DARK))[0];
  assert.match(css, /ui-sans-serif, system-ui, sans-serif/);
  assert.match(css, /ui-monospace/);
  assert.doesNotMatch(css, /Geist/i);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hardcoded hex colors");
});

test("an SVG artifact centers in the frame and an HTML page does not", () => {
  const svg = styleBlocks(artifactDocument("svg", "<svg></svg>", DARK))[0];
  assert.match(svg, /min-height:\s*100vh/);
  assert.match(svg, /display:\s*grid/);
  assert.match(svg, /place-items:\s*center/);
  const html = styleBlocks(artifactDocument("html", "<svg></svg>", DARK))[0];
  assert.doesNotMatch(html, /place-items:\s*center/);
});

test("a document without a theme follows the system colors", () => {
  const css = styleBlocks(artifactDocument("html", "<p>Plain</p>"))[0];
  assert.match(css, /color-scheme:\s*light dark;/);
  assert.match(css, /^@layer orbit-base \{/);
});

for (const field of ["background", "surface", "foreground", "muted", "border", "accent", "ring", "radius"] as const) {
  for (const value of ["red;} body { display: none", "</style><script>alert(1)</script>", "url(https://example.invalid/x.png)", "URL(x)", "rgb(0 0 0) { }", ""]) {
    test(`a theme ${field} of ${JSON.stringify(value)} is rejected`, () => {
      assert.throws(() => artifactDocument("html", "<p>Page</p>", { ...DARK, [field]: value }));
    });
  }
}

test("a theme with an unknown scheme or extra field is rejected", () => {
  assert.throws(() => artifactDocument("html", "<p>Page</p>", { ...DARK, scheme: "blue" } as unknown as ArtifactTheme));
  assert.throws(() => artifactDocument("html", "<p>Page</p>", { ...DARK, font: "serif" } as unknown as ArtifactTheme));
});

test("resolved color formats pass theme validation", () => {
  for (const value of ["rgb(11, 12, 15)", "rgba(0, 0, 0, 0.5)", "color(srgb 0.04 0.05 0.06 / 0.5)", "oklch(0.7 0.1 50)", "#0b0c0f"]) {
    assert.doesNotThrow(() => artifactDocument("html", "<p>Page</p>", { ...DARK, background: value }), value);
  }
});

import { transform } from "sucrase";
import { z } from "zod";
import type { ArtifactKind } from "./detect";

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'";

const REPORT_ERRORS = `<script>
(() => {
const report = (value) => parent.postMessage({ type: "orbit-artifact-error", message: String(value?.message ?? value ?? "Unknown error") }, "*");
addEventListener("error", (event) => report(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => report(event.reason));
addEventListener("keydown", (event) => {
  if (event.key === "Escape") parent.postMessage({ type: "orbit-artifact-close" }, "*");
});
})();
</script>`;

export type ArtifactTheme = {
  scheme: "dark" | "light";
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  ring: string;
  radius: string;
};

// Theme values go inside a <style> element, so each must be one plain CSS value: no tag, declaration, or rule can end in it.
const cssValue = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[#a-z0-9(),.%\s/-]+$/i)
  .refine((value) => !/url\(/i.test(value), "url() is not a theme value");

const themeSchema = z.object({
  scheme: z.enum(["dark", "light"]),
  background: cssValue,
  surface: cssValue,
  foreground: cssValue,
  muted: cssValue,
  border: cssValue,
  accent: cssValue,
  ring: cssValue,
  radius: cssValue,
}).strict();

// Without a theme the frame follows the system colors of its own color scheme.
const SYSTEM_THEME = "color-scheme: light dark; --background: Canvas; --surface: Canvas; --foreground: CanvasText; --muted: GrayText; --border: GrayText; --accent: LinkText; --ring: Highlight; --radius: 6px;";

function themeDeclarations(theme: ArtifactTheme | undefined) {
  if (!theme) return SYSTEM_THEME;
  const value = themeSchema.parse(theme);
  return `color-scheme: ${value.scheme}; --background: ${value.background}; --surface: ${value.surface}; --foreground: ${value.foreground}; --muted: ${value.muted}; --border: ${value.border}; --accent: ${value.accent}; --ring: ${value.ring}; --radius: ${value.radius};`;
}

// Every rule sits in one layer, so any unlayered rule the artifact writes wins without a specificity fight.
// The frame's font-src data: blocks Geist, so text uses the system stack.
function baseStyle(kind: ArtifactKind, theme: ArtifactTheme | undefined) {
  const page = kind === "svg"
    ? "body { margin: 0; padding: 16px; min-height: 100vh; display: grid; place-items: center; } body > svg:not([width]) { width: 100%; max-height: calc(100vh - 32px); }"
    : "body { margin: 16px; }";
  return `<style>@layer orbit-base {
:root { ${themeDeclarations(theme)} accent-color: var(--accent); }
*, ::before, ::after { box-sizing: border-box; }
body { background: var(--background); color: var(--foreground); font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; }
${page}
h1, h2, h3, h4, h5, h6 { margin: 1.25em 0 0.5em; line-height: 1.25; font-weight: 600; text-wrap: balance; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.25rem; } h3 { font-size: 1.125rem; } h4 { font-size: 1.0625rem; } h5, h6 { font-size: 1rem; }
h6 { font-weight: 500; color: var(--muted); }
body > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table, figure { margin: 0 0 1em; }
small, figcaption, caption, ::placeholder { color: var(--muted); }
blockquote { padding-left: 1em; border-left: 2px solid var(--border); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--border); margin: 1.5em 0; }
a { color: var(--accent); text-underline-offset: 2px; }
button, input, select, textarea { font: inherit; color: inherit; background-color: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 12px; }
input[type="checkbox"], input[type="radio"], input[type="range"], input[type="color"] { padding: 0; }
button { cursor: pointer; }
button:hover:not(:disabled) { background-color: color-mix(in srgb, var(--surface), var(--foreground) 8%); }
:disabled { opacity: 0.5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background-color: var(--surface); font-weight: 600; }
pre, code, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre, :not(pre) > code, kbd, samp { font-size: 0.875em; }
pre { padding: 12px; overflow-x: auto; background-color: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
img, svg { max-width: 100%; height: auto; }
}</style>`;
}

/** The frame's whole page: the CSP, then Orbit's base stylesheet, then the error bridge, then the artifact. */
export function artifactDocument(kind: ArtifactKind, code: string, theme?: ArtifactTheme): string {
  const style = baseStyle(kind, theme);
  let body = code;
  if (kind === "react") {
    const imports = {
      react: "https://esm.sh/react@19.3.1",
      "react/jsx-runtime": "https://esm.sh/react@19.3.1/jsx-runtime",
      "react-dom": "https://esm.sh/react-dom@19.3.1?deps=react@19.3.1",
      "react-dom/client": "https://esm.sh/react-dom@19.3.1/client?deps=react@19.3.1",
    };
    const module = transform(code, { transforms: ["imports"] }).code.replace(/<\/script/gi, (match) => "<\\/" + match.slice(2));
    body = `<div id="root"></div><script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
import * as __react from "react";
import * as __jsx from "react/jsx-runtime";
import * as __reactDom from "react-dom";
import * as __client from "react-dom/client";
const __modules = new Map([["react", __react], ["react/jsx-runtime", __jsx], ["react-dom", __reactDom], ["react-dom/client", __client]]);
const __exports = {};
((exports, require) => {
${module}
})(__exports, (name) => {
  if (!__modules.has(name)) throw new Error("Unsupported import: " + name);
  return __modules.get(name);
});
__client.createRoot(document.getElementById("root"), { onUncaughtError: (error) => parent.postMessage({ type: "orbit-artifact-error", message: String(error?.message ?? error) }, "*") }).render(__react.createElement(__exports.default));
</script>`;
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">${style}${REPORT_ERRORS}</head><body>${body}</body></html>`;
}

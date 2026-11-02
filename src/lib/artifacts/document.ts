import { transform } from "sucrase";
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

export function artifactDocument(kind: ArtifactKind, code: string): string {
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
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">${REPORT_ERRORS}</head><body>${body}</body></html>`;
}

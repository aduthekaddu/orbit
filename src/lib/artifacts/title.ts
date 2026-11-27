import type { Artifact, ArtifactKind } from "./detect";

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", react: "React" };

const FALLBACK_TITLE: Record<ArtifactKind, string> = { html: "HTML page", svg: "SVG image", react: "React component" };

const MAX_TITLE = 80;
const MAX_SLUG = 60;
// Model text can be one long run of letters. Every scan below reads at most this much, so a title costs the same on any artifact.
const MAX_SCAN = 100_000;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

const REACT_EXPORTS = [
  /\bexport\s+default\s+(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m,
];
const NOT_A_NAME = new Set(["async", "class", "function", "new", "null", "true", "false", "this", "undefined", "void", "typeof", "await"]);

function isBoundary(char: string | undefined) {
  return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

/** The text of the first `<tag>…</tag>` in `lower` before `stop`, as offsets into the source. */
function elementText(source: string, lower: string, tag: string, stop = lower.length): string | null {
  const open = `<${tag}`;
  let from = 0;
  while (from < stop) {
    const start = lower.indexOf(open, from);
    if (start === -1 || start >= stop) return null;
    from = start + open.length;
    if (!isBoundary(lower[from])) continue;
    const bodyStart = lower.indexOf(">", from);
    if (bodyStart === -1) return null;
    const end = lower.indexOf(`</${tag}`, bodyStart);
    if (end === -1) return null;
    return source.slice(bodyStart + 1, end);
  }
  return null;
}

function decodeEntities(text: string) {
  return text
    .replace(/&(lt|gt|quot|apos|nbsp|#39|#x27);/gi, (_match, name: string) => ENTITIES[name.toLowerCase()])
    .replace(/&amp;/gi, "&");
}

/** The first MAX_TITLE code points. Two code units per code point is the most a slice can need. */
function capTitle(text: string) {
  return Array.from(text.slice(0, MAX_TITLE * 2)).slice(0, MAX_TITLE).join("").trimEnd();
}

function cleanTitle(raw: string | null): string {
  if (raw === null) return "";
  return capTitle(decodeEntities(raw.replace(/<[^<>]*>/g, "")).replace(/\s+/g, " ").trim());
}

function markupTitle(kind: "html" | "svg", source: string): string {
  // Lowercase ASCII only, so offsets in `lower` stay offsets in `source`.
  const lower = source.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  if (kind === "svg") return cleanTitle(elementText(source, lower, "title"));
  // A <title> inside an inline SVG names the drawing, not the page.
  const svg = lower.indexOf("<svg");
  const title = cleanTitle(elementText(source, lower, "title", svg === -1 ? lower.length : svg));
  return title || cleanTitle(elementText(source, lower, "h1")) || cleanTitle(elementText(source, lower, "h2"));
}

function reactTitle(source: string): string {
  for (const pattern of REACT_EXPORTS) {
    const name = pattern.exec(source)?.[1];
    if (name && !NOT_A_NAME.has(name)) return capTitle(name);
  }
  return "";
}

/** A short name for an artifact, read from its own code. Render it as text only. */
export function artifactTitle(artifact: Pick<Artifact, "kind" | "code">): string {
  const source = artifact.code.length > MAX_SCAN ? artifact.code.slice(0, MAX_SCAN) : artifact.code;
  const title = artifact.kind === "react" ? reactTitle(source) : markupTitle(artifact.kind, source);
  return title || FALLBACK_TITLE[artifact.kind];
}

/** A download name from the artifact's title, such as `signup-form.html`. */
export function artifactFileName(artifact: Pick<Artifact, "kind" | "language" | "code">): string {
  const slug = artifactTitle(artifact)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const name = Array.from(slug).slice(0, MAX_SLUG).join("").replace(/-+$/, "");
  return `${name || "artifact"}.${artifact.language}`;
}

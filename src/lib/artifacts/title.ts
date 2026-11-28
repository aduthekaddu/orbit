import type { Artifact, ArtifactKind } from "./detect";

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", react: "React" };

export const FALLBACK_TITLE: Readonly<Record<ArtifactKind, string>> = { html: "HTML page", svg: "SVG image", react: "React component" };

const MAX_TITLE = 80;
const MAX_SLUG = 60;
// Model text can be one long run of letters. Every scan below reads at most this much, so a title costs the same on any artifact.
const MAX_SCAN = 100_000;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

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

/** The first MAX_TITLE code points, without trailing space. Two code units per code point is the most a slice can need. */
export function capTitle(text: string) {
  return Array.from(text.slice(0, MAX_TITLE * 2)).slice(0, MAX_TITLE).join("").trimEnd();
}

// Drops every tag and every stray angle bracket in one pass, so no tag piece survives.
function withoutTags(raw: string) {
  let text = "";
  let inTag = false;
  for (const char of raw) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text;
}

function cleanTitle(raw: string | null): string {
  if (raw === null) return "";
  return decodeEntities(withoutTags(raw)).replace(/\s+/g, " ").trim();
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

function skipSpace(source: string, start: number, singleLine = false) {
  let end = start;
  while (end < source.length && /\s/.test(source[end])) {
    if (singleLine && /[\r\n\u2028\u2029]/.test(source[end])) break;
    end++;
  }
  return end;
}

function reactTitle(source: string): string {
  const identifier = /[A-Za-z_$][\w$]*/y;
  const readName = (at: number) => {
    identifier.lastIndex = at;
    return identifier.exec(source)?.[0] ?? "";
  };
  let className = "";
  let bareName = "";
  // Each prefix and its whitespace are consumed once. Look ahead only through this declaration.
  for (const prefix of source.matchAll(/\bexport\s+default\s+/g)) {
    const start = prefix.index + prefix[0].length;
    let word = readName(start);
    let end = start + word.length;
    if (word === "async") {
      const next = skipSpace(source, end);
      if (next === end || readName(next) !== "function") continue;
      word = "function";
      end = next + word.length;
    }
    if (word === "function" || word === "class") {
      let nameAt = skipSpace(source, end);
      if (word === "function" && source[nameAt] === "*") nameAt = skipSpace(source, nameAt + 1);
      if (word === "class" && nameAt === end) continue;
      const name = readName(nameAt);
      if (!name || NOT_A_NAME.has(name)) continue;
      if (word === "function") return name;
      className ||= name;
    } else if (!bareName && word && !NOT_A_NAME.has(word)) {
      end = skipSpace(source, end, true);
      if (source[end] === ";") end = skipSpace(source, end + 1, true);
      if (end === source.length || /[\r\n\u2028\u2029]/.test(source[end])) bareName = word;
    }
  }
  return className || bareName;
}

/** The name an artifact's code gives itself, before the cut to 80 code points. Empty when it names none. */
function readTitle(artifact: Pick<Artifact, "kind" | "code">): string {
  const source = artifact.code.length > MAX_SCAN ? artifact.code.slice(0, MAX_SCAN) : artifact.code;
  return artifact.kind === "react" ? reactTitle(source) : markupTitle(artifact.kind, source);
}

/** A short name for an artifact, read from its own code. Render it as text only. */
export function artifactTitle(artifact: Pick<Artifact, "kind" | "code">): string {
  return capTitle(readTitle(artifact)) || FALLBACK_TITLE[artifact.kind];
}

/**
 * The title to store for an artifact. Dropping tags can join a credential the code holds in pieces, and the cut to 80
 * code points can leave part of one, so the title is masked before the cut and again after it.
 */
export function maskedArtifactTitle(artifact: Pick<Artifact, "kind" | "code">, redact: { text: (text: string) => string }): string {
  return redact.text(capTitle(redact.text(readTitle(artifact)))) || FALLBACK_TITLE[artifact.kind];
}

/** The title an artifact shows: the user's rename when set, else the title read from its code. */
export function shownTitle(row: { userTitle: string | null; derivedTitle: string }): string {
  return row.userTitle ?? row.derivedTitle;
}

/** A download name from the given title, or from the artifact's own title when none is given, such as `signup-form.html`. */
export function artifactFileName(artifact: Pick<Artifact, "kind" | "language" | "code">, title?: string): string {
  const slug = (title?.trim() ? title : artifactTitle(artifact))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const name = Array.from(slug).slice(0, MAX_SLUG).join("").replace(/-+$/, "");
  return `${name || "artifact"}.${artifact.language}`;
}

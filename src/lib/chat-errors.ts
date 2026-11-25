import type { settings } from "./db/schema";
import { stripTerminalControlsWithMap } from "./sandbox/terminal";
import type { SettingsRecord } from "./settings";

const INPUT_ERROR = /^(?:AI_InvalidToolInputError: )?Invalid input for tool ([\w-]+): (.*)$/s;
const ISSUES_MARK = "\nError message: ";
const MODEL_FAILED = "The model request failed";

type StoredColumn = Exclude<keyof typeof settings.$inferSelect, "id" | "updatedAt">;

// A field whose name ends in one of these, optionally plural, numbered or both, must be labelled a credential.
// The rest may take either label.
export const CREDENTIAL_NOUNS = ["key", "token", "secret", "password", "passwd", "passphrase", "pat", "credential", "cookie", "jwt"] as const;
type CredentialName = `${string}${(typeof CREDENTIAL_NOUNS)[number]}${"" | "s"}${"" | `${number}`}`;
export type SettingsLabels<Field extends string> = {
  [Name in Field]: Lowercase<Name> extends CredentialName ? "credential" : "credential" | "setting";
};

// Every stored setting and every settings column must be listed here, so a new
// credential cannot be added without the Redactor covering it.
const SETTINGS_FIELDS = {
  baseUrl: "setting",
  apiKey: "credential",
  searxngUrl: "setting",
  tavilyApiKey: "credential",
  githubToken: "credential",
  githubMcpUrl: "setting",
  model: "setting",
  reasoningEffort: "setting",
} as const satisfies SettingsLabels<keyof SettingsRecord | StoredColumn>;

type SettingsField = keyof typeof SETTINGS_FIELDS;
type CredentialField = { [Field in SettingsField]: (typeof SETTINGS_FIELDS)[Field] extends "credential" ? Field : never }[SettingsField];
export type StoredCredentials = Readonly<Record<CredentialField, string>>;
export type CredentialSource = StoredCredentials & {
  readonly baseUrl?: string;
  readonly searxngUrl?: string;
  readonly githubMcpUrl?: string;
};

const CREDENTIAL_FIELDS = (Object.keys(SETTINGS_FIELDS) as SettingsField[]).filter(
  (field): field is CredentialField => SETTINGS_FIELDS[field] === "credential",
);

const URL_FIELDS = ["baseUrl", "searxngUrl", "githubMcpUrl"] as const;
const URL_PARAM_PATTERN = new RegExp(`(?:${[...CREDENTIAL_NOUNS, "auth", "authorization", "pass", "pwd", "sig", "signature"].join("|")})s?\\d*$`, "i");

export const REDACTED = "[redacted]";
// Saved and model-facing text keeps a shorter value, such as the placeholder "ollama", so
// ordinary words in replies survive. The minimum is longer than REDACTED, so no masked
// credential is part of the marker.
export const MIN_CREDENTIAL_LENGTH = 12;
const MIN_DIAGNOSTIC_BASE64_BYTES = 4;
const MAX_JSON_ESCAPE_PASSES = 3;
const MAX_PERCENT_PASSES = 2;

const B64_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
  B64_TABLE[65 + i] = i;
  B64_TABLE[97 + i] = 26 + i;
}
for (let i = 0; i < 10; i++) B64_TABLE[48 + i] = 52 + i;
B64_TABLE[43] = 62; // '+'
B64_TABLE[45] = 62; // '-'
B64_TABLE[47] = 63; // '/'
B64_TABLE[95] = 63; // '_'

function isCredentialQueryParam(name: string): boolean {
  const normalized = name.replace(/[-_]/g, "");
  return normalized.length > 0 && URL_PARAM_PATTERN.test(normalized);
}

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlSecrets(rawUrl: string | undefined): string[] {
  if (!rawUrl) return [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (url.password) {
    found.push(url.password);
    const decoded = safeDecodeComponent(url.password);
    if (decoded !== url.password) found.push(decoded);
  } else if (url.username) {
    found.push(url.username);
    const decoded = safeDecodeComponent(url.username);
    if (decoded !== url.username) found.push(decoded);
  }
  for (const [key, value] of url.searchParams.entries()) {
    if (value && isCredentialQueryParam(key)) found.push(value);
  }
  return found;
}

export function redactUrl(raw: string, redact: Redactor): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redact.text(raw);
  }
  const hasUserinfo = url.username !== "" || url.password !== "";
  const hasQuery = url.search !== "";
  const hasHash = url.hash !== "";
  if (!hasUserinfo && !hasQuery && !hasHash) {
    const masked = redact.text(raw);
    return masked === raw ? raw : masked;
  }
  const schemeEnd = raw.indexOf("://");
  const afterScheme = schemeEnd >= 0 ? raw.slice(schemeEnd + 3) : "";
  const pathStart = afterScheme.search(/[/?#]/);
  const hadExplicitSlash = pathStart >= 0 && afterScheme[pathStart] === "/";
  const pathPart = url.pathname === "/" && !hadExplicitSlash ? "" : redact.text(url.pathname);
  const queryPart = hasQuery
    ? `?${[...url.searchParams.entries()].map(([key]) => `${redact.text(key).replace(/[&=]/g, encodeURIComponent)}=${REDACTED}`).join("&")}`
    : "";
  const hashPart = hasHash ? `#${REDACTED}` : "";
  const userinfoPart = hasUserinfo ? `${REDACTED}@` : "";
  return `${url.protocol}//${userinfoPart}${redact.text(url.host)}${pathPart}${queryPart}${hashPart}`;
}

type IndexedView = {
  text: string;
  starts: Int32Array;
  ends: Int32Array;
};

function composeView(base: IndexedView | null, text: string, starts: Int32Array, ends: Int32Array): IndexedView {
  if (!base) return { text, starts, ends };
  const mappedStarts = new Int32Array(starts.length);
  const mappedEnds = new Int32Array(ends.length);
  for (let i = 0; i < starts.length; i++) {
    mappedStarts[i] = base.starts[starts[i]];
    mappedEnds[i] = base.ends[ends[i] - 1];
  }
  return { text, starts: mappedStarts, ends: mappedEnds };
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function decodeJsonEscapesOnce(src: string, base: IndexedView | null): IndexedView | null {
  if (!src.includes("\\")) return null;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let changed = false;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 92 && i + 1 < src.length) {
      const next = src.charCodeAt(i + 1);
      let decoded: string | null = null;
      let width = 2;
      if (next === 34) decoded = '"';
      else if (next === 92) decoded = "\\";
      else if (next === 47) decoded = "/";
      else if (next === 98) decoded = "\b";
      else if (next === 102) decoded = "\f";
      else if (next === 110) decoded = "\n";
      else if (next === 114) decoded = "\r";
      else if (next === 116) decoded = "\t";
      else if (next === 117 && i + 5 < src.length) {
        const d0 = hexDigit(src.charCodeAt(i + 2));
        const d1 = hexDigit(src.charCodeAt(i + 3));
        const d2 = hexDigit(src.charCodeAt(i + 4));
        const d3 = hexDigit(src.charCodeAt(i + 5));
        if (d0 >= 0 && d1 >= 0 && d2 >= 0 && d3 >= 0) {
          decoded = String.fromCharCode((d0 << 12) | (d1 << 8) | (d2 << 4) | d3);
          width = 6;
        }
      }
      if (decoded !== null) {
        changed = true;
        chars.push(decoded);
        starts.push(i);
        ends.push(i + width);
        i += width - 1;
        continue;
      }
    }
    chars.push(src[i]);
    starts.push(i);
    ends.push(i + 1);
  }
  if (!changed) return null;
  return composeView(base, chars.join(""), Int32Array.from(starts), Int32Array.from(ends));
}

function percentByte(src: string, at: number): number {
  if (at + 2 >= src.length || src.charCodeAt(at) !== 37) return -1;
  const hi = hexDigit(src.charCodeAt(at + 1));
  const lo = hexDigit(src.charCodeAt(at + 2));
  return hi >= 0 && lo >= 0 ? (hi << 4) | lo : -1;
}

function decodePercentOnce(src: string, base: IndexedView | null, plusAsSpace: boolean): IndexedView | null {
  if (!src.includes("%") && !(plusAsSpace && src.includes("+"))) return null;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let changed = false;
  let i = 0;
  while (i < src.length) {
    const first = percentByte(src, i);
    if (first >= 0) {
      const bytes: number[] = [];
      const byteAt: number[] = [];
      while (i < src.length) {
        const value = percentByte(src, i);
        if (value < 0) break;
        bytes.push(value);
        byteAt.push(i);
        i += 3;
      }
      let j = 0;
      while (j < bytes.length) {
        const b0 = bytes[j];
        if (b0 < 0x80) {
          changed = true;
          chars.push(String.fromCharCode(b0));
          starts.push(byteAt[j]);
          ends.push(byteAt[j] + 3);
          j += 1;
        } else if (b0 >= 0xc2 && b0 <= 0xdf && j + 1 < bytes.length && (bytes[j + 1] & 0xc0) === 0x80) {
          changed = true;
          chars.push(String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[j + 1] & 0x3f)));
          starts.push(byteAt[j]);
          ends.push(byteAt[j + 1] + 3);
          j += 2;
        } else if (
          b0 >= 0xe0 && b0 <= 0xef && j + 2 < bytes.length &&
          (bytes[j + 1] & 0xc0) === 0x80 && (bytes[j + 2] & 0xc0) === 0x80 &&
          !(b0 === 0xe0 && bytes[j + 1] < 0xa0) && !(b0 === 0xed && bytes[j + 1] >= 0xa0)
        ) {
          changed = true;
          chars.push(String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[j + 1] & 0x3f) << 6) | (bytes[j + 2] & 0x3f)));
          starts.push(byteAt[j]);
          ends.push(byteAt[j + 2] + 3);
          j += 3;
        } else if (
          b0 >= 0xf0 && b0 <= 0xf4 && j + 3 < bytes.length &&
          (bytes[j + 1] & 0xc0) === 0x80 && (bytes[j + 2] & 0xc0) === 0x80 && (bytes[j + 3] & 0xc0) === 0x80 &&
          !(b0 === 0xf0 && bytes[j + 1] < 0x90) && !(b0 === 0xf4 && bytes[j + 1] > 0x8f)
        ) {
          changed = true;
          const cp = ((b0 & 0x07) << 18) | ((bytes[j + 1] & 0x3f) << 12) | ((bytes[j + 2] & 0x3f) << 6) | (bytes[j + 3] & 0x3f);
          const pair = String.fromCodePoint(cp);
          const s = byteAt[j];
          const e = byteAt[j + 3] + 3;
          chars.push(pair[0], pair[1]);
          starts.push(s, s);
          ends.push(e, e);
          j += 4;
        } else {
          const at = byteAt[j];
          chars.push(src[at], src[at + 1], src[at + 2]);
          starts.push(at, at + 1, at + 2);
          ends.push(at + 1, at + 2, at + 3);
          j += 1;
        }
      }
      continue;
    }
    if (plusAsSpace && src.charCodeAt(i) === 43) {
      changed = true;
      chars.push(" ");
      starts.push(i);
      ends.push(i + 1);
      i += 1;
      continue;
    }
    chars.push(src[i]);
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  if (!changed) return null;
  return composeView(base, chars.join(""), Int32Array.from(starts), Int32Array.from(ends));
}

function decodeTerminal(src: string, base: IndexedView | null): IndexedView | null {
  const stripped = stripTerminalControlsWithMap(src);
  if (!stripped) return null;
  return composeView(base, stripped.text, stripped.starts, stripped.ends);
}

// Every index where needle starts in text, overlaps included. Knuth-Morris-Pratt, so a key of one
// repeated character costs the same as any other key.
function starts(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!text.includes(needle)) return found;
  const fallback = new Int32Array(needle.length);
  for (let at = 1, matched = 0; at < needle.length; at++) {
    while (matched > 0 && needle[at] !== needle[matched]) matched = fallback[matched - 1];
    if (needle[at] === needle[matched]) matched++;
    fallback[at] = matched;
  }
  for (let at = 0, matched = 0; at < text.length; at++) {
    while (matched > 0 && text[at] !== needle[matched]) matched = fallback[matched - 1];
    if (text[at] === needle[matched]) matched++;
    if (matched === needle.length) {
      found.push(at - matched + 1);
      matched = fallback[matched - 1];
    }
  }
  return found;
}

function startsBytes(haystack: Uint8Array, needle: Uint8Array): number[] {
  const found: number[] = [];
  if (needle.length === 0 || haystack.length < needle.length) return found;
  const fallback = new Int32Array(needle.length);
  for (let at = 1, matched = 0; at < needle.length; at++) {
    while (matched > 0 && needle[at] !== needle[matched]) matched = fallback[matched - 1];
    if (needle[at] === needle[matched]) matched++;
    fallback[at] = matched;
  }
  for (let at = 0, matched = 0; at < haystack.length; at++) {
    while (matched > 0 && haystack[at] !== needle[matched]) matched = fallback[matched - 1];
    if (haystack[at] === needle[matched]) matched++;
    if (matched === needle.length) {
      found.push(at - matched + 1);
      matched = fallback[matched - 1];
    }
  }
  return found;
}

function decodeB64Slice(src: string, start: number, end: number): Uint8Array {
  const len = end - start;
  const full = Math.floor(len / 4);
  const tail = len % 4;
  const outLen = full * 3 + (tail === 3 ? 2 : tail === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = start;
  const limit = start + full * 4;
  while (i < limit) {
    const a = B64_TABLE[src.charCodeAt(i)];
    const b = B64_TABLE[src.charCodeAt(i + 1)];
    const c = B64_TABLE[src.charCodeAt(i + 2)];
    const d = B64_TABLE[src.charCodeAt(i + 3)];
    out[o] = (a << 2) | (b >> 4);
    out[o + 1] = ((b & 15) << 4) | (c >> 2);
    out[o + 2] = ((c & 3) << 6) | d;
    o += 3;
    i += 4;
  }
  if (tail === 2) {
    const a = B64_TABLE[src.charCodeAt(i)];
    const b = B64_TABLE[src.charCodeAt(i + 1)];
    out[o] = (a << 2) | (b >> 4);
  } else if (tail === 3) {
    const a = B64_TABLE[src.charCodeAt(i)];
    const b = B64_TABLE[src.charCodeAt(i + 1)];
    const c = B64_TABLE[src.charCodeAt(i + 2)];
    out[o] = (a << 2) | (b >> 4);
    out[o + 1] = ((b & 15) << 4) | (c >> 2);
  }
  return out;
}

function minB64CharsForBytes(byteLength: number): number {
  const last = byteLength - 1;
  return Math.floor(last / 3) * 4 + (last % 3) + 2;
}

function b64CharStart(byteIndex: number): number {
  return Math.floor(byteIndex / 3) * 4 + (byteIndex % 3);
}

function b64CharEnd(lastByteIndex: number): number {
  return Math.floor(lastByteIndex / 3) * 4 + (lastByteIndex % 3) + 2;
}

function scanBase64(
  src: string,
  view: IndexedView | null,
  secretBytes: readonly Uint8Array[],
  minPayload: number,
  shortExactB64: readonly string[],
  onSpan: (start: number, end: number) => void,
) {
  if (secretBytes.length === 0 && shortExactB64.length === 0) return;
  const minRun = shortExactB64.length > 0 ? Math.min(minPayload, 4) : minPayload;
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code >= 128 || B64_TABLE[code] < 0) {
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < src.length) {
      const c = src.charCodeAt(i);
      if (c >= 128 || B64_TABLE[c] < 0) break;
      i += 1;
    }
    const payloadEnd = i;
    let pad = 0;
    while (pad < 2 && i < src.length && src.charCodeAt(i) === 61) {
      i += 1;
      pad += 1;
    }
    const runEnd = i;
    const payloadLen = payloadEnd - runStart;
    if (runEnd - runStart < minRun) continue;
    if (shortExactB64.length > 0) {
      const token = src.slice(runStart, runEnd);
      if (shortExactB64.includes(token)) {
        const s = view ? view.starts[runStart] : runStart;
        const e = view ? view.ends[runEnd - 1] : runEnd;
        onSpan(s, e);
      }
    }
    if (secretBytes.length === 0 || payloadLen < minPayload) continue;
    for (let off = 0; off < 4; off++) {
      if (payloadLen - off < minPayload) break;
      const decoded = decodeB64Slice(src, runStart + off, payloadEnd);
      for (const needle of secretBytes) {
        if (decoded.length < needle.length) continue;
        for (const bStart of startsBytes(decoded, needle)) {
          const cStart = runStart + off + b64CharStart(bStart);
          let cEnd = runStart + off + b64CharEnd(bStart + needle.length - 1);
          if (cEnd >= payloadEnd) cEnd = runEnd;
          const s = view ? view.starts[cStart] : cStart;
          const e = view ? view.ends[cEnd - 1] : cEnd;
          onSpan(s, e);
        }
      }
    }
  }
}

type SecretSet = {
  strings: readonly string[];
  bytesForBase64: readonly Uint8Array[];
  minB64Payload: number;
  shortExactB64: readonly string[];
  hasSpace: boolean;
};

function buildViews(text: string, hasSpace: boolean): Array<IndexedView | null> {
  const views: Array<IndexedView | null> = [null];
  const addSecondary = (src: string, base: IndexedView | null) => {
    const term = decodeTerminal(src, base);
    if (term) {
      views.push(term);
      const pct = decodePercentOnce(term.text, term, hasSpace);
      if (pct) views.push(pct);
    }
    let curPct: IndexedView | null = null;
    for (let pass = 0; pass < MAX_PERCENT_PASSES; pass++) {
      const next = decodePercentOnce(curPct ? curPct.text : src, curPct ?? base, hasSpace);
      if (!next) break;
      views.push(next);
      const pctTerm = decodeTerminal(next.text, next);
      if (pctTerm) views.push(pctTerm);
      curPct = next;
    }
  };
  addSecondary(text, null);
  let curJson: IndexedView | null = null;
  for (let pass = 0; pass < MAX_JSON_ESCAPE_PASSES; pass++) {
    const next = decodeJsonEscapesOnce(curJson ? curJson.text : text, curJson);
    if (!next) break;
    views.push(next);
    addSecondary(next.text, next);
    curJson = next;
  }
  return views;
}

function findMergedSpans(text: string, set: SecretSet): Array<[number, number]> {
  if (!text || (set.strings.length === 0 && set.bytesForBase64.length === 0 && set.shortExactB64.length === 0)) return [];
  let reach: Int32Array | undefined;
  const mark = (start: number, end: number) => {
    if (start < 0 || end <= start || start >= text.length) return;
    reach ??= new Int32Array(text.length);
    const clamped = Math.min(end, text.length);
    if (clamped > reach[start]) reach[start] = clamped;
  };
  for (const view of buildViews(text, set.hasSpace)) {
    const src = view ? view.text : text;
    for (const secret of set.strings) {
      for (const at of starts(src, secret)) {
        const s = view ? view.starts[at] : at;
        const e = view ? view.ends[at + secret.length - 1] : at + secret.length;
        mark(s, e);
      }
    }
    scanBase64(src, view, set.bytesForBase64, set.minB64Payload, set.shortExactB64, mark);
  }
  if (!reach) return [];
  const spans: Array<[number, number]> = [];
  let spanStart = -1;
  let spanEnd = -1;
  for (let at = 0; at < text.length; at++) {
    if (reach[at] === 0) continue;
    if (at > spanEnd) {
      if (spanStart >= 0) spans.push([spanStart, spanEnd]);
      spanStart = at;
      spanEnd = reach[at];
    } else if (reach[at] > spanEnd) {
      spanEnd = reach[at];
    }
  }
  if (spanStart >= 0) spans.push([spanStart, spanEnd]);
  return spans;
}

function hasAnyMatch(text: string, set: SecretSet): boolean {
  if (!text || (set.strings.length === 0 && set.bytesForBase64.length === 0 && set.shortExactB64.length === 0)) return false;
  let found = false;
  for (const view of buildViews(text, set.hasSpace)) {
    const src = view ? view.text : text;
    if (set.strings.some((secret) => src.includes(secret))) return true;
    scanBase64(src, view, set.bytesForBase64, set.minB64Payload, set.shortExactB64, () => {
      found = true;
    });
    if (found) return true;
  }
  return false;
}

function applySpans(text: string, spans: readonly [number, number][]): string {
  if (spans.length === 0) return text;
  let out = "";
  let plain = 0;
  for (const [start, end] of spans) {
    out += text.slice(plain, start) + REDACTED;
    plain = end;
  }
  return out + text.slice(plain);
}

function endsWithSecretPrefix(decoded: Uint8Array, secrets: readonly Uint8Array[]): boolean {
  for (const secret of secrets) {
    const maxCheck = Math.min(decoded.length, secret.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      let ok = true;
      const offset = decoded.length - len;
      for (let k = 0; k < len; k++) {
        if (decoded[offset + k] !== secret[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

export type StreamRedactor = {
  push: (delta: string) => string;
  flush: (extra?: string) => string;
  bufferedLength: () => number;
  takeTail: () => string;
};

export class Redactor {
  readonly #everySet: SecretSet;
  readonly #longSet: SecretSet;
  readonly #maxLongLength: number;
  readonly #maxLongBytes: number;

  constructor(...sources: [CredentialSource | null, ...CredentialSource[]]) {
    const secrets = new Set(
      sources.flatMap((credentials) =>
        credentials === null
          ? []
          : [
              ...CREDENTIAL_FIELDS.map((field) => credentials[field]),
              ...URL_FIELDS.flatMap((field) => urlSecrets(credentials[field])),
            ],
      ),
    );
    const every = [...secrets].filter((value) => value !== "");
    const long = every.filter((value) => value.length >= MIN_CREDENTIAL_LENGTH);
    const everyBytes = every.map((value) => Buffer.from(value, "utf8"));
    const longBytes = long.map((value) => Buffer.from(value, "utf8"));
    const diagB64Bytes = everyBytes.filter((bytes) => bytes.length >= MIN_DIAGNOSTIC_BASE64_BYTES);
    const shortExactB64 = everyBytes
      .filter((bytes) => bytes.length > 0 && bytes.length < MIN_DIAGNOSTIC_BASE64_BYTES)
      .flatMap((bytes) => [bytes.toString("base64"), bytes.toString("base64url")]);
    this.#everySet = {
      strings: every,
      bytesForBase64: diagB64Bytes,
      minB64Payload: diagB64Bytes.length > 0 ? Math.min(...diagB64Bytes.map((b) => minB64CharsForBytes(b.length))) : Infinity,
      shortExactB64,
      hasSpace: every.some((value) => value.includes(" ")),
    };
    this.#longSet = {
      strings: long,
      bytesForBase64: longBytes,
      minB64Payload: longBytes.length > 0 ? Math.min(...longBytes.map((b) => minB64CharsForBytes(b.length))) : Infinity,
      shortExactB64: [],
      hasSpace: long.some((value) => value.includes(" ")),
    };
    this.#maxLongLength = long.reduce((max, value) => Math.max(max, value.length), 0);
    this.#maxLongBytes = longBytes.reduce((max, bytes) => Math.max(max, bytes.length), 0);
  }

  get hasLongSecrets(): boolean {
    return this.#longSet.strings.length > 0;
  }

  get streamHoldback(): number {
    return Math.max(0, this.#maxLongLength - 1);
  }

  #holds(text: string): boolean {
    return hasAnyMatch(text, this.#everySet);
  }

  // Saved messages and tool results: each long credential (literal or encoded) becomes the marker.
  // A marker next to other text can spell a credential again; then the whole text is dropped.
  text(message: string): string {
    const spans = findMergedSpans(message, this.#longSet);
    if (spans.length === 0) return message;
    const masked = applySpans(message, spans);
    return hasAnyMatch(masked, this.#longSet) ? REDACTED : masked;
  }

  // Masks a sequence of string segments that will be joined together (for example, consecutive text parts),
  // catching credentials split across segment boundaries without merging the segments themselves.
  maskSegments(segments: readonly string[]): string[] {
    if (segments.length === 0 || !this.hasLongSecrets) return [...segments];
    if (segments.length === 1) return [this.text(segments[0])];
    const joined = segments.join("");
    const spans = findMergedSpans(joined, this.#longSet);
    if (spans.length === 0) return [...segments];
    const out = [...segments];
    const startsAt: number[] = [];
    let cursor = 0;
    for (const seg of segments) {
      startsAt.push(cursor);
      cursor += seg.length;
    }
    const findSeg = (pos: number) => {
      let lo = 0;
      let hi = segments.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (startsAt[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    // Build per-segment edits in reverse order so offsets stay valid.
    for (let i = spans.length - 1; i >= 0; i--) {
      const [sStart, sEnd] = spans[i];
      const firstSeg = findSeg(sStart);
      const lastSeg = findSeg(sEnd - 1);
      const localStart = sStart - startsAt[firstSeg];
      const localEnd = sEnd - startsAt[lastSeg];
      if (firstSeg === lastSeg) {
        out[firstSeg] = out[firstSeg].slice(0, localStart) + REDACTED + out[firstSeg].slice(localEnd);
      } else {
        out[firstSeg] = out[firstSeg].slice(0, localStart) + REDACTED;
        for (let mid = firstSeg + 1; mid < lastSeg; mid++) out[mid] = "";
        out[lastSeg] = out[lastSeg].slice(localEnd);
      }
    }
    if (hasAnyMatch(out.join(""), this.#longSet)) {
      return out.map((_, index) => (index === 0 ? REDACTED : ""));
    }
    return out;
  }

  // Bounded streaming masker: holds back at most (longest key - 1) characters on normal prose,
  // extending up to a hard cap only while an active escape or matching Base64 prefix is in the tail.
  createStream(): StreamRedactor {
    const hold = this.streamHoldback;
    const rawHoldCap = Math.max(hold * 6 + 64, 4096);
    const maxB64Hold = Math.ceil((this.#maxLongBytes + 2) / 3) * 4;
    let buffer = "";
    let redacting = false;

    const neededHold = (buf: string): number => {
      if (hold === 0 || buf.length <= hold) return hold;
      let need = hold;
      const tailSliceStart = Math.max(0, buf.length - rawHoldCap);
      const tailSlice = buf.slice(tailSliceStart);
      if (tailSlice.includes("\\") || tailSlice.includes("%") || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(tailSlice)) {
        for (const view of buildViews(tailSlice, this.#longSet.hasSpace)) {
          if (!view) continue;
          if (view.text.length <= hold) {
            need = Math.max(need, tailSlice.length);
          } else {
            const rawStart = view.starts[view.text.length - hold];
            need = Math.max(need, tailSlice.length - rawStart);
          }
        }
      }
      if (this.#longSet.bytesForBase64.length > 0) {
        let end = buf.length;
        let pad = 0;
        while (pad < 2 && end > 0 && buf.charCodeAt(end - 1) === 61) {
          end -= 1;
          pad += 1;
        }
        let start = end;
        const limit = Math.max(0, end - maxB64Hold);
        while (start > limit) {
          const code = buf.charCodeAt(start - 1);
          if (code >= 128 || B64_TABLE[code] < 0) break;
          start -= 1;
        }
        const runLen = buf.length - start;
        if (runLen > need) {
          const payloadLen = end - start;
          for (let off = 0; off < 4; off++) {
            if (payloadLen - off < 2) break;
            const decoded = decodeB64Slice(buf, start + off, end);
            if (endsWithSecretPrefix(decoded, this.#longSet.bytesForBase64)) {
              need = Math.max(need, runLen);
              break;
            }
          }
        }
      }
      return Math.min(need, rawHoldCap);
    };

    return {
      bufferedLength: () => buffer.length,
      takeTail: () => {
        if (!buffer) {
          redacting = false;
          return "";
        }
        if (redacting) {
          let out = this.text(buffer);
          if (out.startsWith(REDACTED)) out = out.slice(REDACTED.length);
          buffer = "";
          redacting = false;
          return out;
        }
        const raw = buffer;
        buffer = "";
        return raw;
      },
      push: (delta: string) => {
        if (!delta) return "";
        if (hold === 0) return delta;
        buffer += delta;
        let emitted = "";
        while (buffer.length > 0) {
          const keep = neededHold(buffer);
          if (buffer.length <= keep) break;
          const safeEnd = buffer.length - keep;
          const spans = findMergedSpans(buffer, this.#longSet);
          if (spans.length === 0 || spans[0][0] >= safeEnd) {
            emitted += buffer.slice(0, safeEnd);
            buffer = buffer.slice(safeEnd);
            redacting = false;
            break;
          }
          const [sStart, sEnd] = spans[0];
          if (sStart > 0) {
            emitted += buffer.slice(0, sStart);
            redacting = false;
          }
          if (sEnd <= safeEnd) {
            let nextOffset = sEnd;
            const afterMarker = REDACTED + buffer.slice(sEnd, sEnd + hold);
            if (hasAnyMatch(afterMarker, this.#longSet)) {
              const markerSpans = findMergedSpans(afterMarker, this.#longSet);
              const touching = markerSpans.find(([start]) => start < REDACTED.length);
              if (touching) nextOffset = sEnd + Math.max(0, touching[1] - REDACTED.length);
            }
            if (!redacting) emitted += REDACTED;
            redacting = false;
            buffer = buffer.slice(nextOffset);
            continue;
          }
          if (buffer.length - sStart > rawHoldCap) {
            if (!redacting) {
              emitted += REDACTED;
              redacting = true;
            }
            buffer = buffer.slice(Math.max(sStart + 1, sEnd - hold));
            break;
          }
          buffer = buffer.slice(sStart);
          break;
        }
        return emitted;
      },
      flush: (extra = "") => {
        buffer += extra;
        if (!buffer) {
          redacting = false;
          return "";
        }
        if (hold === 0) {
          const out = buffer;
          buffer = "";
          return out;
        }
        let out = this.text(buffer);
        if (redacting && out.startsWith(REDACTED)) out = out.slice(REDACTED.length);
        buffer = "";
        redacting = false;
        return out;
      },
    };
  }

  // Log lines, stream error text and tool errors are never masked in place. The detail is shown
  // only when neither it nor any text it was built from holds a stored credential of any length, so no
  // collapse, strip, cut or join can leave part of one. Otherwise the first fallback that holds none is
  // shown, or nothing.
  diagnostic(detail: string, sources: readonly string[] = [], fallbacks: readonly string[] = [REDACTED]): string {
    if (![detail, ...sources].some((text) => this.#holds(text))) return detail;
    return fallbacks.find((text) => !this.#holds(text)) ?? "";
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
  }

  // One string, so the line checked is the line printed: a credential spread across the label and
  // the details is found too.
  logError(label: string, ...details: string[]) {
    console.error(this.diagnostic([label, ...details].join(" "), [], [`${label} ${REDACTED}`, label, REDACTED]));
  }
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

type Limits = { issues: number; part: number; field: number; message: number; reason: number };
const CUT: Limits = { issues: 3, part: 40, field: 80, message: 120, reason: 240 };
// The same text with no cut, so a credential that a cut would hide is still found.
const WHOLE: Limits = { issues: Infinity, part: Infinity, field: Infinity, message: Infinity, reason: Infinity };

function short(text: string, limit: number) {
  const flat = text.replace(/[\x00-\x1f\x7f\s]+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function issueLine(issue: unknown, limits: Limits): string[] {
  if (!issue || typeof issue !== "object") return [];
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string") return [];
  // Paths can hold keys the model chose, so every part is bounded.
  const field = Array.isArray(path) ? short(path.map((part) => short(String(part), limits.part)).join("."), limits.field) : "";
  const reason = short(message, limits.message);
  return [field ? `${field}: ${reason}` : reason];
}

// The SDK writes the rejected value, then "\nError message: ", then the schema issues as JSON.
// The value is compact JSON with no raw newline, so the first newline starts the issues.
function inputProblem(rest: string, limits: Limits) {
  const unknown = "the input does not match the tool schema";
  if (rest.startsWith("AI_JSONParseError:")) return "the input is not valid JSON";
  const mark = rest.indexOf(ISSUES_MARK);
  if (mark === -1) return unknown;
  try {
    const issues: unknown = JSON.parse(rest.slice(mark + ISSUES_MARK.length));
    const lines = Array.isArray(issues) ? issues.slice(0, limits.issues).flatMap((issue) => issueLine(issue, limits)) : [];
    return lines.length > 0 ? short(lines.join("; "), limits.reason) : unknown;
  } catch {
    return unknown;
  }
}

function errorText(message: string, redact: Redactor) {
  const match = INPUT_ERROR.exec(message);
  if (!match) return redact.diagnostic(cleanErrorText(message), [message]);
  const head = `Invalid input for tool ${match[1]}: `;
  const whole = head + inputProblem(match[2], WHOLE);
  return redact.diagnostic(head + inputProblem(match[2], CUT), [message, whole], [head + REDACTED, REDACTED]);
}

export function streamErrorMessage(error: unknown, redact: Redactor) {
  if (typeof error === "string") return errorText(error, redact);
  const message = error instanceof Error ? error.message : MODEL_FAILED;
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    const text = errorText(message, redact);
    redact.logError("chat stream error", text);
    return text;
  }
  redact.logError("chat stream error", message);
  return redact.diagnostic(MODEL_FAILED);
}

// One line for the operator in place of the SDK's raw dump, which carries request and response bodies.
export function logProviderError(error: unknown, redact: Redactor) {
  const name = error instanceof Error ? error.name : typeof error;
  const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? String(error.statusCode) : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  redact.logError("chat provider error", ...[name, status, message].filter((part) => part !== ""));
}

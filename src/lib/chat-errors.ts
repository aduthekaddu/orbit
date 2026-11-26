import type { settings } from "./db/schema";
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

const CREDENTIAL_FIELDS = (Object.keys(SETTINGS_FIELDS) as SettingsField[]).filter(
  (field): field is CredentialField => SETTINGS_FIELDS[field] === "credential",
);

export const REDACTED = "[redacted]";
// Saved and model-facing text keeps a shorter value, such as the placeholder "ollama", so
// ordinary words in replies survive. The minimum is longer than REDACTED, so no masked
// credential is part of the marker.
export const MIN_CREDENTIAL_LENGTH = 12;

// Every index where needle starts in text, overlaps included. Knuth-Morris-Pratt, so a key of one
// repeated character costs the same as any other key.
function starts(text: string, needle: string) {
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

// Each run of characters that any occurrence of a secret covers, overlaps included, becomes one marker.
function maskRuns(text: string, secrets: readonly string[]) {
  let reach: Int32Array | undefined;
  for (const secret of secrets) {
    for (const at of starts(text, secret)) {
      reach ??= new Int32Array(text.length);
      reach[at] = Math.max(reach[at], at + secret.length);
    }
  }
  if (!reach) return text;
  let masked = "";
  let end = -1;
  let plain = 0;
  for (let at = 0; at < text.length; at++) {
    if (reach[at] === 0) continue;
    if (at > end) masked += text.slice(plain, at) + REDACTED;
    end = Math.max(end, reach[at]);
    plain = end;
  }
  return masked + text.slice(plain);
}

export class Redactor {
  readonly #every: string[];
  readonly #long: string[];

  constructor(...sources: [StoredCredentials | null, ...StoredCredentials[]]) {
    const secrets = new Set(sources.flatMap((credentials) =>
      credentials === null ? [] : CREDENTIAL_FIELDS.map((field) => credentials[field])));
    this.#every = [...secrets].filter((value) => value !== "");
    this.#long = this.#every.filter((value) => value.length >= MIN_CREDENTIAL_LENGTH);
  }

  #holds(text: string) {
    return this.#every.some((secret) => text.includes(secret));
  }

  // Saved messages and tool results: each long credential becomes the marker. A marker next to other
  // text can spell a credential again; then the whole text is dropped.
  text(message: string) {
    const masked = maskRuns(message, this.#long);
    return this.#long.some((secret) => masked.includes(secret)) ? REDACTED : masked;
  }

  // Log lines, stream error text and GitHub tool errors are never masked in place. The detail is shown
  // only when neither it nor any text it was built from holds a stored credential of any length, so no
  // collapse, strip, cut or join can leave part of one. Otherwise the first fallback that holds none is
  // shown, or nothing.
  diagnostic(detail: string, sources: readonly string[] = [], fallbacks: readonly string[] = [REDACTED]) {
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

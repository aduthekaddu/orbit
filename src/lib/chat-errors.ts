import type { settings } from "./db/schema";
import type { SettingsRecord } from "./settings";

const INPUT_ERROR = /^(?:AI_InvalidToolInputError: )?Invalid input for tool ([\w-]+): (.*)$/s;
const ISSUES_MARK = "\nError message: ";
const ISSUE_LIMIT = 3;
const PART_LIMIT = 40;
const FIELD_LIMIT = 80;
const MESSAGE_LIMIT = 120;
const REASON_LIMIT = 240;

type StoredColumn = Exclude<keyof typeof settings.$inferSelect, "id" | "updatedAt">;

// A field whose name ends in one of these, optionally plural or numbered, must be labelled a credential.
// The rest may take either label.
export const CREDENTIAL_NOUNS = ["key", "token", "secret", "password", "passwd", "passphrase", "pat", "credential", "cookie", "jwt"] as const;
type CredentialName = `${string}${(typeof CREDENTIAL_NOUNS)[number]}${"" | "s" | `${number}`}`;
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
// ordinary words in replies survive. Log lines and error text drop it. The minimum is longer
// than REDACTED, so no masked credential is part of the marker.
export const MIN_CREDENTIAL_LENGTH = 12;

// Each run of characters that any occurrence of a secret covers, overlaps included, becomes one marker.
function maskRuns(text: string, secrets: readonly string[]) {
  let covered: Uint8Array | undefined;
  for (const secret of secrets) {
    let end = 0;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      covered ??= new Uint8Array(text.length);
      covered.fill(1, Math.max(at, end), at + secret.length);
      end = at + secret.length;
    }
  }
  if (!covered) return text;
  let masked = "";
  for (let start = 0; start < text.length; ) {
    let stop = start;
    while (stop < text.length && covered[stop] === covered[start]) stop++;
    masked += covered[start] ? REDACTED : text.slice(start, stop);
    start = stop;
  }
  return masked;
}

// A marker next to other text can spell a credential again; then the whole text is dropped.
function mask(text: string, replaced: readonly string[], forbidden: readonly string[]) {
  const result = maskRuns(text, replaced);
  return forbidden.some((secret) => result.includes(secret)) ? REDACTED : result;
}

export class Redactor {
  readonly #every: string[];
  readonly #long: string[];

  constructor(...sources: [StoredCredentials, ...StoredCredentials[]]) {
    const secrets = new Set(sources.flatMap((credentials) => CREDENTIAL_FIELDS.map((field) => credentials[field])));
    this.#every = [...secrets].filter((value) => value !== "");
    this.#long = this.#every.filter((value) => value.length >= MIN_CREDENTIAL_LENGTH);
  }

  text(message: string) {
    return mask(message, this.#long, this.#long);
  }

  diagnostic(message: string) {
    return mask(message, this.#long, this.#every);
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
  }

  logError(label: string, ...details: string[]) {
    console.error(label, ...details.map((detail) => this.diagnostic(detail)));
  }
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

// Masks before it cuts, so a cut cannot leave part of a credential.
function short(text: string, limit: number, redact: Redactor) {
  const flat = redact.diagnostic(text.replace(/[\x00-\x1f\x7f\s]+/g, " "));
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// Paths can hold keys the model chose, so every part is bounded. A credential that only the
// joined path spells would lose its tail in a part's cut, so that path is masked whole first.
function pathField(path: unknown[], redact: Redactor) {
  const whole = path.map(String).join(".");
  const masked = redact.diagnostic(whole);
  if (masked !== whole) return short(masked, FIELD_LIMIT, redact);
  return short(path.map((part) => short(String(part), PART_LIMIT, redact)).join("."), FIELD_LIMIT, redact);
}

function issueLine(issue: unknown, redact: Redactor): string[] {
  if (!issue || typeof issue !== "object") return [];
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string") return [];
  const field = Array.isArray(path) ? pathField(path, redact) : "";
  const reason = short(message, MESSAGE_LIMIT, redact);
  return [field ? `${field}: ${reason}` : reason];
}

// The SDK writes the rejected value, then "\nError message: ", then the schema issues as JSON.
// The value is compact JSON with no raw newline, so the first newline starts the issues.
function inputProblem(rest: string, redact: Redactor) {
  const unknown = "the input does not match the tool schema";
  if (rest.startsWith("AI_JSONParseError:")) return "the input is not valid JSON";
  const mark = rest.indexOf(ISSUES_MARK);
  if (mark === -1) return unknown;
  try {
    const issues: unknown = JSON.parse(rest.slice(mark + ISSUES_MARK.length));
    const lines = Array.isArray(issues) ? issues.slice(0, ISSUE_LIMIT).flatMap((issue) => issueLine(issue, redact)) : [];
    return lines.length > 0 ? short(lines.join("; "), REASON_LIMIT, redact) : unknown;
  } catch {
    return unknown;
  }
}

function shortToolInputError(text: string, redact: Redactor) {
  const match = INPUT_ERROR.exec(text);
  return match ? `Invalid input for tool ${match[1]}: ${inputProblem(match[2], redact)}` : undefined;
}

function errorText(message: string, redact: Redactor) {
  return redact.diagnostic(shortToolInputError(message, redact) ?? cleanErrorText(message));
}

export function streamErrorMessage(error: unknown, redact: Redactor) {
  if (typeof error === "string") return errorText(error, redact);
  const message = error instanceof Error ? error.message : "The model request failed";
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    const text = errorText(message, redact);
    redact.logError("chat stream error", text);
    return text;
  }
  redact.logError("chat stream error", message);
  return "The model request failed";
}

// One line for the operator in place of the SDK's raw dump, which carries request and response bodies.
export function logProviderError(error: unknown, redact: Redactor) {
  const name = error instanceof Error ? error.name : typeof error;
  const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? String(error.statusCode) : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  redact.logError("chat provider error", ...[name, status, message].filter((part) => part !== ""));
}

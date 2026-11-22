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

// A field whose name ends like a credential's must be labelled one. The rest may take either label.
type CredentialName = `${string}${"key" | "token" | "secret" | "password"}`;
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
// A shorter value, such as "ollama" or "type", also occurs in ordinary reply text and
// field names, and masking it would rewrite saved replies. The minimum is longer than
// REDACTED, so each replacement shortens the text and no credential equals the marker.
export const MIN_CREDENTIAL_LENGTH = 12;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  readonly #pattern: RegExp | null;

  constructor(...sources: [StoredCredentials, ...StoredCredentials[]]) {
    const secrets = new Set(sources.flatMap((credentials) => CREDENTIAL_FIELDS.map((field) => credentials[field])));
    const matched = [...secrets].filter((value) => value.length >= MIN_CREDENTIAL_LENGTH).sort((left, right) => right.length - left.length);
    this.#pattern = matched.length > 0 ? new RegExp(matched.map(escapeRegExp).join("|"), "g") : null;
  }

  // Repeats until nothing matches, because a marker next to other text can spell another credential.
  text(message: string) {
    if (!this.#pattern) return message;
    let text = message;
    for (let previous = ""; previous !== text; ) {
      previous = text;
      text = text.replace(this.#pattern, REDACTED);
    }
    return text;
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
  }

  logError(label: string, ...details: string[]) {
    console.error(label, ...details.map((detail) => this.text(detail)));
  }
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

function short(text: string, limit: number) {
  const flat = text.replace(/[\x00-\x1f\x7f\s]+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// Paths can hold keys the model chose, so every part of a reason is bounded.
function issueLine(issue: unknown): string[] {
  if (!issue || typeof issue !== "object") return [];
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string") return [];
  const field = Array.isArray(path) ? short(path.map((part) => short(String(part), PART_LIMIT)).join("."), FIELD_LIMIT) : "";
  const reason = short(message, MESSAGE_LIMIT);
  return [field ? `${field}: ${reason}` : reason];
}

// The SDK writes the rejected value, then "\nError message: ", then the schema issues as JSON.
// The value is compact JSON with no raw newline, so the first newline starts the issues.
function inputProblem(rest: string) {
  const unknown = "the input does not match the tool schema";
  if (rest.startsWith("AI_JSONParseError:")) return "the input is not valid JSON";
  const mark = rest.indexOf(ISSUES_MARK);
  if (mark === -1) return unknown;
  try {
    const issues: unknown = JSON.parse(rest.slice(mark + ISSUES_MARK.length));
    const lines = Array.isArray(issues) ? issues.slice(0, ISSUE_LIMIT).flatMap(issueLine) : [];
    return lines.length > 0 ? short(lines.join("; "), REASON_LIMIT) : unknown;
  } catch {
    return unknown;
  }
}

function shortToolInputError(text: string) {
  const match = INPUT_ERROR.exec(text);
  return match ? `Invalid input for tool ${match[1]}: ${inputProblem(match[2])}` : undefined;
}

// Masks before shortening, so a cut cannot leave part of a credential, and again after
// joining the error path, which can spell one.
function errorText(message: string, redact: Redactor) {
  const masked = redact.text(message);
  return redact.text(shortToolInputError(masked) ?? cleanErrorText(masked));
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
  const message = error instanceof Error ? error.message : String(error);
  redact.logError("chat provider error", ...[name, status, message].filter((part) => part !== ""));
}

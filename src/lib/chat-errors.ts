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
} as const satisfies Record<keyof SettingsRecord | StoredColumn, "credential" | "setting">;

type SettingsField = keyof typeof SETTINGS_FIELDS;
type CredentialField = { [Field in SettingsField]: (typeof SETTINGS_FIELDS)[Field] extends "credential" ? Field : never }[SettingsField];
export type StoredCredentials = Readonly<Record<CredentialField, string>>;

const CREDENTIAL_FIELDS = (Object.keys(SETTINGS_FIELDS) as SettingsField[]).filter(
  (field): field is CredentialField => SETTINGS_FIELDS[field] === "credential",
);

function sanitize(message: string, secrets: readonly string[]) {
  let text = message;
  for (const value of secrets) text = text.split(value).join("[redacted]");
  return text;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return sanitize(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[sanitize(key, secrets)] = redactValue(child, secrets);
  return copy;
}

export class Redactor {
  readonly #secrets: readonly string[];

  constructor(credentials: StoredCredentials) {
    this.#secrets = CREDENTIAL_FIELDS.map((field) => credentials[field])
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
  }

  text(message: string) {
    return sanitize(message, this.#secrets);
  }

  value(value: unknown) {
    return redactValue(value, this.#secrets);
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

export function streamErrorMessage(error: unknown, redact: Redactor) {
  if (typeof error === "string") return redact.text(shortToolInputError(error) ?? cleanErrorText(error));
  const message = error instanceof Error ? error.message : "The model request failed";
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    const text = redact.text(shortToolInputError(message) ?? cleanErrorText(message));
    redact.logError("chat stream error", text);
    return text;
  }
  redact.logError("chat stream error", message);
  return "The model request failed";
}

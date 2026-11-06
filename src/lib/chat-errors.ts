const INPUT_ERROR = /^(?:AI_InvalidToolInputError: )?Invalid input for tool ([\w-]+): (.*)$/s;
const ISSUES_MARK = "\nError message: ";
const ISSUE_LIMIT = 3;
const PART_LIMIT = 40;
const FIELD_LIMIT = 80;
const MESSAGE_LIMIT = 120;
const REASON_LIMIT = 240;

export function sanitize(message: string, secret: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
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

export function streamErrorMessage(error: unknown, secret: string) {
  if (typeof error === "string") return sanitize(shortToolInputError(error) ?? cleanErrorText(error), secret);
  const message = error instanceof Error ? error.message : "The model request failed";
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    const text = sanitize(shortToolInputError(message) ?? cleanErrorText(message), secret);
    console.error("chat stream error", text);
    return text;
  }
  console.error("chat stream error", sanitize(message, secret));
  return "The model request failed";
}

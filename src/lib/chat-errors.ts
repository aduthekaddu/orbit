const INPUT_ERROR = /^(?:AI_InvalidToolInputError: )?Invalid input for tool ([\w-]+): (.*)$/s;
const ISSUES_MARK = "\nError message: ";
const ISSUE_LIMIT = 3;

export function sanitize(message: string, secret: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

function issueLine(issue: unknown): string[] {
  if (!issue || typeof issue !== "object") return [];
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string") return [];
  const field = Array.isArray(path) ? path.join(".") : "";
  return [field ? `${field}: ${message}` : message];
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
    return lines.length > 0 ? lines.join("; ") : unknown;
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

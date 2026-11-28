import { tool } from "ai";
import type Docker from "dockerode";
import type { Redactor } from "../chat-errors";
import { sandboxImages } from "../sandbox/images";
import { runCode, sandboxDocker } from "../sandbox/run";
import { runCodeInputSchema, type RunCodeInput } from "../sandbox/spec";
import { createStoppedRuns, type StoppedRuns } from "./stopped-runs";

export const SANDBOX_FAILURES = {
  configuration: "Sandbox configuration is invalid. Check DOCKER_HOST on the server.",
  denied: "Sandbox access was denied. Check the Docker proxy.",
  failed: "Code sandbox failed. Check the server logs.",
} as const;

export function sandboxImageMissing(language: RunCodeInput["language"]) {
  return `Sandbox image is missing. Run docker pull ${sandboxImages[language].image}`;
}

/** The fixed message for a sandbox call that threw. It never carries Docker's error text. */
export function sandboxFailureMessage(error: unknown, language: RunCodeInput["language"]): string {
  const status = dockerStatus(error);
  if (sandboxMisconfigured(error)) return SANDBOX_FAILURES.configuration;
  if (status === 403) return SANDBOX_FAILURES.denied;
  if (status === 404) return sandboxImageMissing(language);
  return SANDBOX_FAILURES.failed;
}

function dockerStatus(error: unknown) {
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function sandboxMisconfigured(error: unknown) {
  return error instanceof Error && (error.message === "DOCKER_HOST must point to the local Docker socket proxy" || "code" in error && error.code === "ERR_INVALID_URL");
}

async function execute(connect: () => Docker, input: RunCodeInput, abortSignal?: AbortSignal, redact?: Redactor) {
  try {
    return await runCode(connect(), input, abortSignal, redact).result;
  } catch (error) {
    if (abortSignal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
    const status = dockerStatus(error);
    const category = sandboxMisconfigured(error) ? "ConfigurationError"
      : error instanceof Error && ["TimeoutError", "TypeError", "SyntaxError", "ZodError"].includes(error.name) ? error.name : "Error";
    console.error("code sandbox failed", { error: category, ...(status === undefined ? {} : { status }) });
    return { ok: false, error: sandboxFailureMessage(error, input.language) };
  }
}

export function createRunCodeTool(stopped: StoppedRuns = createStoppedRuns(), connect: () => Docker = sandboxDocker, redact?: Redactor) {
  return tool({
    description: "Run Python or JavaScript to calculate exact answers and inspect data. Uses only the standard library, with no network or persistent files. Each run has a 10 second limit.",
    inputSchema: runCodeInputSchema,
    execute: (input, { abortSignal, toolCallId }) => stopped.track(toolCallId, execute(connect, input, abortSignal, redact)),
  });
}

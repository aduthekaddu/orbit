import { tool } from "ai";
import type Docker from "dockerode";
import type { Redactor } from "../chat-errors";
import { sandboxImages } from "../sandbox/images";
import { runCode, sandboxDocker } from "../sandbox/run";
import { runCodeInputSchema, type RunCodeInput } from "../sandbox/spec";
import { createStoppedRuns, type StoppedRuns } from "./stopped-runs";

async function execute(connect: () => Docker, input: RunCodeInput, abortSignal?: AbortSignal, redact?: Redactor) {
  try {
    return await runCode(connect(), input, abortSignal, redact).result;
  } catch (error) {
    if (abortSignal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
    const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
    const configuration = error instanceof Error && (error.message === "DOCKER_HOST must point to the local Docker socket proxy" || "code" in error && error.code === "ERR_INVALID_URL");
    const category = configuration ? "ConfigurationError"
      : error instanceof Error && ["TimeoutError", "TypeError", "SyntaxError", "ZodError"].includes(error.name) ? error.name : "Error";
    console.error("code sandbox failed", { error: category, ...(status === undefined ? {} : { status }) });
    const message = configuration ? "Sandbox configuration is invalid. Check DOCKER_HOST on the server."
      : status === 403 ? "Sandbox access was denied. Check the Docker proxy."
      : status === 404 ? `Sandbox image is missing. Run docker pull ${sandboxImages[input.language].image}`
      : "Code sandbox failed. Check the server logs.";
    return { ok: false, error: message };
  }
}

export function createRunCodeTool(stopped: StoppedRuns = createStoppedRuns(), connect: () => Docker = sandboxDocker, redact?: Redactor) {
  return tool({
    description: "Run Python or JavaScript to calculate exact answers and inspect data. Uses only the standard library, with no network or persistent files. Each run has a 10 second limit.",
    inputSchema: runCodeInputSchema,
    execute: (input, { abortSignal, toolCallId }) => stopped.track(toolCallId, execute(connect, input, abortSignal, redact)),
  });
}

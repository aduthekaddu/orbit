import { tool } from "ai";
import { sandboxImages } from "../sandbox/images";
import { runCode, sandboxDocker } from "../sandbox/run";
import { runCodeInputSchema } from "../sandbox/spec";

export function createRunCodeTool() {
  return tool({
    description: "Run Python or JavaScript to calculate exact answers and inspect data. Uses only the standard library, with no network or persistent files. Each run has a 10 second limit.",
    inputSchema: runCodeInputSchema,
    execute: async (input, { abortSignal }) => {
      try {
        return await runCode(sandboxDocker(), input, abortSignal);
      } catch (error) {
        if (abortSignal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
        const missing = error && typeof error === "object" && "statusCode" in error && error.statusCode === 404;
        return { ok: false, error: missing ? `Sandbox image is missing. Run docker pull ${sandboxImages[input.language].image}` : "Docker is unavailable. Check the local sandbox connection." };
      }
    },
  });
}

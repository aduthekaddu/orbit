import { inspect } from "node:util";

const DEFAULT_INTERVAL_MS = 25;

export async function eventually(read, predicate, { timeoutMs, what, intervalMs = DEFAULT_INTERVAL_MS }) {
  if (!(timeoutMs > 0) || !(intervalMs > 0)) throw new TypeError("eventually needs a positive timeoutMs and intervalMs");
  if (typeof what !== "string" || what === "") throw new TypeError("eventually needs `what`: the state it waits for");
  const started = performance.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    const left = timeoutMs - (performance.now() - started);
    if (left <= 0) {
      const last = inspect(value, { depth: 4, breakLength: 120, maxStringLength: 500, maxArrayLength: 20 });
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}. Last value read: ${last}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}

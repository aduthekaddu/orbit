export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { getDb } = await import("./lib/db");
    getDb();
    const { startDreamScheduler } = await import("./lib/memory/schedule");
    startDreamScheduler();
    const { sandboxEnabled } = await import("./lib/sandbox/enabled");
    if (sandboxEnabled()) {
      const { startSandboxSweep } = await import("./lib/sandbox/sweep");
      startSandboxSweep();
    }
  }
}

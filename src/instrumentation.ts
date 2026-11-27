export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getInstance } = await import("./lib/instance-settings");
    getInstance();
    const { startDreamScheduler } = await import("./lib/memory/schedule");
    startDreamScheduler();
    const { sandboxEnabled } = await import("./lib/sandbox/enabled");
    if (sandboxEnabled()) {
      const { startSandboxSweep } = await import("./lib/sandbox/sweep");
      startSandboxSweep();
    }
  }
}

export const SERVER_TIME_HEADER = "x-orbit-server-time";

export type OrbitTiming = { startedAt: number; thoughtMs?: number };

export function readOrbitTiming(metadata: unknown): OrbitTiming | undefined {
  if (!metadata || typeof metadata !== "object" || !("orbitTiming" in metadata)) return;
  const timing = metadata.orbitTiming;
  if (!timing || typeof timing !== "object" || !("startedAt" in timing)) return;
  if (typeof timing.startedAt !== "number" || !Number.isFinite(timing.startedAt)) return;
  const thoughtMs = "thoughtMs" in timing ? timing.thoughtMs : undefined;
  return {
    startedAt: timing.startedAt,
    thoughtMs: typeof thoughtMs === "number" && Number.isFinite(thoughtMs) ? thoughtMs : undefined,
  };
}

function seconds(ms: number) {
  return Math.max(0, Math.floor(ms / 1000));
}

export function thoughtLabel(ms: number) {
  const total = seconds(ms);
  if (total === 0) return "<1s";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function thinkingLabel(ms: number) {
  const total = seconds(ms);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

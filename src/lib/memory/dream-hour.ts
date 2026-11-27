import { readEnv } from "../env";

export function parseEnvDreamHour(): number {
  const raw = readEnv("ORBIT_DREAM_HOUR");
  if (!raw) return 3;
  const hour = Number(raw);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;
}

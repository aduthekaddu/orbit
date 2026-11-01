export function resolveTrustedOrigins(baseURL: string, extra?: string) {
  const origins = new Set<string>();
  try {
    origins.add(new URL(baseURL).origin);
  } catch {
    // A malformed base URL leaves only the explicit origins.
  }
  for (const origin of extra?.split(",") ?? []) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

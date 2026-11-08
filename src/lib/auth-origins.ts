export const LOCAL_AUTH_URL = "http://127.0.0.1:3210";

type AuthUrlEnv = {
  BETTER_AUTH_URL?: string;
  ORBIT_PUBLIC_URL?: string;
};

/** The public URL wins so cookies and links match the address behind the tunnel. */
export function resolveAuthBaseUrl(env: AuthUrlEnv) {
  return env.ORBIT_PUBLIC_URL?.trim() || env.BETTER_AUTH_URL?.trim() || LOCAL_AUTH_URL;
}

export function resolveTrustedOrigins(baseURL: string, extra?: string, publicURL?: string) {
  const origins = new Set<string>();
  for (const url of [baseURL, publicURL]) {
    if (!url?.trim()) continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      // A malformed URL leaves only the other origins.
    }
  }
  for (const origin of extra?.split(",") ?? []) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
}

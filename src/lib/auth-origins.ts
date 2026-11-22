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

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A write that another origin sent with the user's cookie. Sec-Fetch-Site must be same-origin when the browser sends it,
 * and Origin must be a trusted origin when present. Unlike better-auth's sign-in check, the comparison is by exact string,
 * so a wildcard pattern in ORBIT_TRUSTED_ORIGINS trusts nothing here. A request with neither header passes, so curl and
 * scripts keep working. Browsers send Origin on every cross-origin write.
 */
export function isCrossOriginWrite(request: Pick<Request, "method" | "headers">, trustedOrigins: readonly string[]) {
  if (READ_METHODS.has(request.method)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return true;
  const origin = request.headers.get("origin");
  return origin !== null && !trustedOrigins.includes(origin);
}

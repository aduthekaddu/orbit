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
 * A write that another origin sent with the user's cookie. The browser sets Sec-Fetch-Site itself and a page cannot forge
 * it, so a write it marks same-origin passes without consulting the trusted list, and a wildcard pattern in
 * ORBIT_TRUSTED_ORIGINS still lets that user write. Any other Sec-Fetch-Site is refused. Without Fetch Metadata the Origin
 * decides, and the comparison is by exact string, so a wildcard entry trusts nothing there. A request with neither header
 * passes, so curl and scripts keep working. Browsers send Origin on every cross-origin write.
 */
export function isCrossOriginWrite(request: Pick<Request, "method" | "headers">, trustedOrigins: readonly string[]) {
  if (READ_METHODS.has(request.method)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return false;
  if (site !== null) return true;
  const origin = request.headers.get("origin");
  return origin !== null && !trustedOrigins.includes(origin);
}

import crypto from "node:crypto";

type SessionCookie = "secure" | "plain" | "both" | "none";

function sessionCookie(names: Set<string>): SessionCookie {
  const secure = names.has("__Secure-better-auth.session_token");
  const plain = names.has("better-auth.session_token");
  if (secure && plain) return "both";
  if (secure) return "secure";
  if (plain) return "plain";
  return "none";
}

function requestKind(pathname: string, headers: Headers) {
  if (headers.get("next-router-prefetch")) return "prefetch";
  if (headers.get("rsc")) return "rsc";
  if (pathname.startsWith("/api")) return "api";
  return headers.get("sec-fetch-dest") ?? "-";
}

/**
 * One log line for a request that reached Orbit without a valid session.
 * `session=none` means the browser sent no session cookie. Any other value means the server rejected the one it got.
 */
export function describeAuthMiss(pathname: string, headers: Headers) {
  const cookie = headers.get("cookie") ?? "";
  const names = new Set(cookie.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean));
  const userAgent = headers.get("user-agent") ?? "";
  return [
    `auth miss path=${pathname}`,
    `kind=${requestKind(pathname, headers)}`,
    `site=${headers.get("sec-fetch-site") ?? "-"}`,
    `session=${sessionCookie(names)}`,
    `access=${names.has("CF_Authorization") ? "yes" : "no"}`,
    `cookieBytes=${cookie.length}`,
    `ray=${headers.get("cf-ray") ?? "-"}`,
    `ua=${crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 8)}`,
  ].join(" ");
}

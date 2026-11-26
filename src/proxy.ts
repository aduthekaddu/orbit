import { NextResponse, type NextRequest } from "next/server";
import { getAuth, getTrustedOrigins } from "@/lib/auth";
import { describeAuthMiss } from "@/lib/auth-miss";
import { isCrossOriginWrite } from "@/lib/auth-origins";

const PUBLIC_PAGES = new Set(["/login", "/signup"]);

function routeResponse(request: NextRequest, pathname: string, signedIn: boolean) {
  if (pathname.startsWith("/api")) {
    if (!signedIn) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (isCrossOriginWrite(request, getTrustedOrigins())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.next();
  }
  if (!signedIn && !PUBLIC_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (signedIn && PUBLIC_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname === "/_next" ||
    pathname.startsWith("/_next/") ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/setup" ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const { response: session, headers } = await getAuth().api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  if (!session && !PUBLIC_PAGES.has(pathname)) console.warn(describeAuthMiss(pathname, request.headers));

  const response = routeResponse(request, pathname, Boolean(session));
  for (const cookie of headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

export const config = {
  // Every API path runs the proxy, including one that ends in an image extension.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

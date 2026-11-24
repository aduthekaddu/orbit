import { NextResponse, type NextRequest } from "next/server";
import { auth, trustedOrigins } from "@/lib/auth";
import { describeAuthMiss } from "@/lib/auth-miss";
import { isCrossOriginWrite } from "@/lib/auth-origins";

const PUBLIC_PAGES = new Set(["/login", "/signup"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth") ||
    pathname === "/api/setup" ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session && !PUBLIC_PAGES.has(pathname)) console.warn(describeAuthMiss(pathname, request.headers));

  if (pathname.startsWith("/api")) {
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (isCrossOriginWrite(request, trustedOrigins)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.next();
  }

  if (!session && !PUBLIC_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (session && PUBLIC_PAGES.has(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Every API path runs the proxy, including one that ends in an image extension.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

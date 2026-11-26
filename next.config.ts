import type { NextConfig } from "next";

const appPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://esm.sh${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const apiPolicy = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const responseHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3", "dockerode", "sqlite-vec"],
  async headers() {
    return [
      {
        source: "/((?!api(?:/|$)|s(?:/|$)|_next(?:/|$)).*)",
        headers: [...responseHeaders, { key: "Content-Security-Policy", value: appPolicy }],
      },
      {
        source: "/api/:path*",
        headers: [...responseHeaders, { key: "Content-Security-Policy", value: apiPolicy }],
      },
    ];
  },
};

export default nextConfig;

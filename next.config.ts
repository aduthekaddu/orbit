import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3", "dockerode", "sqlite-vec"],
  async headers() {
    return [
      {
        source: "/((?!s(?:/|$)).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      ...["/", "/new", "/login", "/signup", "/settings", "/admin", "/memory", "/tools", "/c/:id", "/invite/:token"].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: "frame-src 'none'; frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      })),
      {
        source: "/invite/:token",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;

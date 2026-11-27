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
      ...["/", "/new", "/login", "/signup", "/settings", "/memory", "/c/:id"].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: "frame-src 'none'; frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      })),
    ];
  },
};

export default nextConfig;

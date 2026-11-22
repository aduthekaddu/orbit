import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "dockerode", "sqlite-vec"],
  async headers() {
    return ["/", "/login", "/signup", "/settings", "/memory", "/c/:id"].map((source) => ({
      source,
      headers: [{ key: "Content-Security-Policy", value: "frame-src 'none'" }],
    }));
  },
};

export default nextConfig;

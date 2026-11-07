import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "dockerode", "sqlite-vec"],
};

export default nextConfig;

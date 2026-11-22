import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "dockerode", "sqlite-vec"],
  // An artifact preview runs model code in a srcdoc frame. This stops that frame from loading a URL (#132).
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-src 'none'" }] }];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; must be external for proper bundling under Node.
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // App Router route handlers need this enabled (defaults true in recent Next, kept explicit).
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
};

export default nextConfig;

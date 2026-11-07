import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const studioRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  // Engine packages spawn REA, use node:sqlite and child processes: keep
  // them as plain Node modules on the server instead of bundling them.
  serverExternalPackages: ["@rea-studio/core", "@rea-studio/agent", "@ai-sdk/mcp"],
  turbopack: { root: studioRoot },
  outputFileTracingRoot: studioRoot,
  poweredByHeader: false,
};

export default nextConfig;

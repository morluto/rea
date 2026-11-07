/** Files required by the production MCP bootstrap before it can serve requests. */
export const MCP_BOOTSTRAP_FILES = Object.freeze([
  "scripts/lib/cli-runtime-files.mjs",
  "scripts/lib/cli-process-environment.mjs",
  "dist/cli-runtime/cliBuiltinArguments.js",
  "dist/mcp/main.js",
]);

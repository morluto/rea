/**
 * Canonical public identity shared by packaging, setup, MCP, and skill install.
 * Centralization prevents persistent client registrations from drifting from
 * the npm package or executable exposed in package.json.
 */
export const PRODUCT_IDENTITY = {
  displayName: "REA",
  packageName: "reaa",
  cliBinary: "rea",
  mcpCommand: "npx -y reaa mcp",
  mcpServerKey: "rea",
  skillName: "rea-analysis",
  configFileName: "rea.json",
} as const;

/** Public REA identifiers kept together for consistent packaging and setup. */
export const PRODUCT_IDENTITY = {
  displayName: "REA",
  packageName: "@morluto/rea",
  cliBinary: "rea",
  mcpCommand: "npx -y @morluto/rea mcp",
  mcpServerKey: "rea",
  skillName: "rea-analysis",
  configFileName: "rea.json",
} as const;

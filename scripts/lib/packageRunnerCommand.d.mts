/** Exact host argv for a pinned registry package's MCP entry point. */
export function packageRunnerCommand(
  runner: "npx" | "bunx",
  packageSpecifier: string,
  platform: NodeJS.Platform,
): readonly string[];

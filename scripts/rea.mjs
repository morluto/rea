#!/usr/bin/env node

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while only dist/main.js may serve the 46-tool stdio server.
const args = process.argv.slice(2);
const isMcpMode =
  args[0] === "--mcp" || (args.length === 1 && args[0] === "mcp");

if (isMcpMode) {
  const { run } = await import("../dist/main.js");
  process.exitCode = await run();
} else {
  const { createCli } = await import("../dist/cli.js");
  await createCli().serve(args);
}

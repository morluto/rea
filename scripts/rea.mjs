#!/usr/bin/env node

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

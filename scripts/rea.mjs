#!/usr/bin/env node

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while only dist/main.js may serve the 78-tool stdio server.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");

if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/main.js");
  await runEntrypoint();
} else {
  const { createCli } = await import("../dist/cli.js");
  const { sanitizeCliOutput } = await import("../dist/cliOutput.js");
  await createCli().serve(args, {
    stdout: (output) => process.stdout.write(sanitizeCliOutput(output)),
  });
}

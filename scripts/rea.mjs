#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while only dist/main.js may serve the 78-tool stdio server.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;
const isMcpMode =
  args.length === 1 && (args[0] === "--mcp" || args[0] === "mcp");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFiles = isMcpMode
  ? ["dist/main.js"]
  : ["dist/cli.js", "dist/cliOutput.js"];

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exitCode = 1;
} else if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/main.js");
  await runEntrypoint();
} else {
  const { createCli } = await import("../dist/cli.js");
  const { sanitizeCliOutput } = await import("../dist/cliOutput.js");
  await createCli().serve(args, {
    stdout: (output) => process.stdout.write(sanitizeCliOutput(output)),
  });
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

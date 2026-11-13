import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createVerifierMcpOwner } from "./verifier-mcp-owner.mjs";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FULL_CATALOG_IDENTITY } from "../../dist/catalogIdentity.js";
import { verifyCompleteToolCatalog } from "./verify-package-core.mjs";

/** Install the selected archive or registry specifier with an owned ten-minute deadline. */
export async function installCanaryPackage(
  specifier,
  workspace,
  environment,
  commands,
) {
  const prefix = join(workspace, "installed");
  await commands.exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      specifier,
    ],
    {
      cwd: workspace,
      env: environment,
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return join(prefix, "node_modules", "rea-agents");
}

/** Exercise the same installed CLI/MCP contract before and after publication. */
export async function verifyInstalledCanaryPackage(
  packageRoot,
  version,
  workspace,
  { environment, commands },
) {
  const installed = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (installed.name !== "rea-agents" || installed.version !== version)
    throw new Error(
      `Installed package identity is ${installed.name}@${installed.version}, expected rea-agents@${version}`,
    );
  const launcher = join(packageRoot, "scripts", "rea.mjs");
  for (const option of ["--help", "--llms"])
    await commands.exec(process.execPath, [launcher, option], {
      cwd: workspace,
      env: environment,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher, "mcp"],
    cwd: workspace,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "release-package-canary", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length < 16_384)
      stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
  });
  const owner = createVerifierMcpOwner();
  commands.adopt(owner, "installed package MCP transport");
  return withVerifierCleanup(async () => {
    try {
      await owner.open(client, transport);
      const toolNames = await verifyCompleteToolCatalog(client);
      return {
        mcpTools: toolNames.length,
        canonicalMcpTools: FULL_CATALOG_IDENTITY.counts.mcp_tools,
      };
    } catch (cause) {
      throw new Error(`Installed package MCP verification failed: ${stderr}`, {
        cause,
      });
    }
  }, [() => owner.close()]);
}

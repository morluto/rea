import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? ""))
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");

const serverEnvironment = { ...process.env };
delete serverEnvironment.HOPPER_TARGET_PATH;
const canaryRoot = await mkdtemp(join(tmpdir(), "rea-published-canary-"));
const transport = new StdioClientTransport({
  command: "npm",
  args: [
    "exec",
    "--yes",
    `--package=rea-agents@${version}`,
    "--",
    "rea",
    "mcp",
  ],
  cwd: canaryRoot,
  env: serverEnvironment,
  stderr: "pipe",
});
const client = new Client({
  name: "published-package-canary",
  version: "1",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  if (stderr.length < 16_384) stderr += chunk.toString("utf8");
});

let publishedToolCount = 0;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map(({ name }) => name);
  const canonicalToolNames = new Set(
    CATALOG_IDENTITY.tools.map(({ name }) => name),
  );
  const unknownToolNames = toolNames.filter(
    (name) => !canonicalToolNames.has(name),
  );
  publishedToolCount = toolNames.length;
  if (
    publishedToolCount === 0 ||
    new Set(toolNames).size !== publishedToolCount ||
    unknownToolNames.length > 0
  )
    throw new Error(
      `Published MCP exposed an invalid capability-scoped tool projection (${String(publishedToolCount)} tools, unknown: ${unknownToolNames.join(", ") || "none"})`,
    );
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  if (status.isError === true)
    throw new Error("Published target-free MCP session check failed");
} catch (cause) {
  throw new Error(`Published MCP canary failed: ${stderr}`, { cause });
} finally {
  try {
    await client.close();
    await transport.close();
  } finally {
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), package: "rea-agents", version, mcpTools: publishedToolCount, canonicalMcpTools: CATALOG_IDENTITY.counts.mcp_tools })}\n`,
);

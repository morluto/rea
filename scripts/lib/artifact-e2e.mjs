import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const environment = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
  // Artifact workflows have no deep-provider prerequisite or GUI authority.
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
});

/** Execute the compiled CLI with production providers and no test adapters. */
export async function artifactCli(
  command,
  target,
  arguments_ = [],
  options = {},
) {
  return (await artifactCliEvidence(command, target, arguments_, options))
    .normalized_result;
}

/** Execute the compiled CLI and return its complete Evidence record. */
export async function artifactCliEvidence(
  command,
  target,
  arguments_ = [],
  { timeoutMs = 60000 } = {},
) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../rea.mjs", import.meta.url)),
      command,
      target,
      ...arguments_,
      "--json",
    ],
    { env: environment(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.error, undefined, stdout);
  assert.ok(evidence.normalized_result, "CLI omitted normalized result");
  return evidence;
}

/** Run a real stdio MCP subprocess, owning and closing its transport. */
export async function withArtifactMcp(target, verify) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
    env: environment(),
    stderr: "pipe",
  });
  const client = new Client({ name: "artifact-real-e2e", version: "1" });
  try {
    await client.connect(transport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    assert.notEqual(opened.isError, true, JSON.stringify(opened));
    await verify(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

/** Require a successful structured MCP tool result rather than its text rendering. */
export async function artifactMcpResult(client, name, arguments_ = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent?.result, "MCP omitted structured result");
  return result.structuredContent.result;
}

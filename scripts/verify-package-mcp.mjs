import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import * as prompts from "./verify-package-prompts.mjs";
import { json } from "./lib/verify-package-core.mjs";

const verifyMcpToolsAndPrompts = async (client, mcpOptions) => {
  if (
    (await client.listTools(undefined, mcpOptions)).tools.length !==
    TOOL_CONTRACTS.length
  )
    throw new Error("packaged MCP tool inventory diverged from contracts");
  await prompts.verifyPromptCatalog(client, mcpOptions, prompts.names);
  await prompts.verifyPromptCompletion(client, mcpOptions, false);
};

const verifyMcpReplay = async (client, mcpOptions, investigationReplay) => {
  const replay = await client.callTool(
    {
      name: "find_changed_behavior",
      arguments: { investigation_run: investigationReplay.arguments },
    },
    mcpOptions,
  );
  const replayEvidence = json(prompts.mcpText(replay));
  const replayWorkspace = json(
    await readFile(investigationReplay.workspacePath, "utf8"),
  );
  if (
    replay.isError === true ||
    replayEvidence.evidence_id !== investigationReplay.evidenceId ||
    replayWorkspace.revision !== investigationReplay.revision
  )
    throw new Error(
      "packaged MCP did not replay with workspace-only authority",
    );
};

const verifyMcpTargetFree = async (client, mcpOptions) => {
  const result = await client.callTool(
    { name: "current_document", arguments: {} },
    mcpOptions,
  );
  if (result.isError !== true)
    throw new Error("packaged target-free MCP omitted no-target error");
};

const verifyMcpUnknownProvider = async (client, mcpOptions) => {
  const unknownProvider = await client.callTool(
    {
      name: "open_binary",
      arguments: {
        path: process.execPath,
        provider_id: "missing-provider",
      },
    },
    mcpOptions,
  );
  if (
    unknownProvider.isError !== true ||
    unknownProvider.structuredContent?.error?.details?.selection_reason !==
      "unknown_provider"
  )
    throw new Error("packaged MCP accepted an unknown analysis provider");
};

const verifyMcpOpenAndBind = async (client, mcpOptions) => {
  const opened = await client.callTool(
    {
      name: "open_binary",
      arguments: { path: process.execPath, provider_id: "hopper" },
    },
    mcpOptions,
  );
  if (opened.isError === true)
    throw new Error("packaged MCP could not open a binary");
  const providerStatusEnvelope = json(
    prompts.mcpText(
      await client.callTool(
        { name: "binary_session", arguments: { detail: "full" } },
        mcpOptions,
      ),
    ),
  );
  const providerStatus = providerStatusEnvelope.result;
  if (
    providerStatus.analysis_provider_binding?.provider?.id !== "hopper" ||
    providerStatus.analysis_provider_binding?.selection_source !== "request"
  )
    throw new Error("packaged MCP omitted its explicit Hopper binding");
};

const verifyMcpLinuxCurrentDocument = async (client, mcpOptions, current) => {
  if (
    current.isError !== true ||
    !prompts
      .mcpText(current)
      .includes("not supported for unattended Linux analysis")
  )
    throw new Error("packaged Linux MCP did not reject an unpinned Hopper");
};

const verifyMcpNonLinuxCurrentDocument = async (
  client,
  mcpOptions,
  current,
) => {
  if (json(prompts.mcpText(current)).result !== "fixture")
    throw new Error("packaged MCP bridge call failed");
  const batch = await client.callTool(
    {
      name: "batch_decompile",
      arguments: { addresses: ["0x1000"] },
    },
    mcpOptions,
  );
  const batchResult = json(prompts.mcpText(batch)).result;
  if (
    batch.isError === true ||
    batchResult?.total !== 1 ||
    batchResult?.succeeded !== 1 ||
    batchResult?.failed !== 0 ||
    batchResult?.items?.[0]?.status !== "ok" ||
    batchResult?.items?.[0]?.pseudocode !== "return 0;"
  )
    throw new Error("packaged MCP structured batch result failed");
};

const verifyMcpBinaryLifecycle = async (client, mcpOptions) => {
  await verifyMcpOpenAndBind(client, mcpOptions);
  await prompts.verifyPromptCompletion(
    client,
    mcpOptions,
    process.platform !== "linux",
  );
  const current = await client.callTool(
    { name: "current_document", arguments: {} },
    mcpOptions,
  );
  if (process.platform === "linux") {
    await verifyMcpLinuxCurrentDocument(client, mcpOptions, current);
  } else {
    await verifyMcpNonLinuxCurrentDocument(client, mcpOptions, current);
  }
  const closed = await client.callTool(
    { name: "close_binary", arguments: {} },
    mcpOptions,
  );
  if (closed.isError === true)
    throw new Error("packaged MCP could not close its binary");
  await prompts.verifyPromptCompletion(client, mcpOptions, false);
};

const verifyMcpEvidenceBundle = async (client, mcpOptions, evidenceRoot) => {
  const mcpBundlePath = join(evidenceRoot, "mcp.json");
  const mcpExport = await client.callTool(
    { name: "export_evidence_bundle", arguments: { path: mcpBundlePath } },
    mcpOptions,
  );
  if (mcpExport.isError === true)
    throw new Error("packaged MCP evidence export failed");
  const mcpImport = await client.callTool(
    { name: "import_evidence_bundle", arguments: { path: mcpBundlePath } },
    mcpOptions,
  );
  if (mcpImport.isError === true)
    throw new Error("packaged MCP evidence import failed");
};

/** Connect to the packaged MCP server and exercise the target-free catalog. */
export async function verifyPackageMcp({
  cli,
  environment,
  evidenceRoot,
  investigationReplay,
}) {
  const transport = new StdioClientTransport({
    command: cli,
    args: ["mcp"],
    env: {
      ...environment,
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([]),
    },
    stderr: "pipe",
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += chunk.toString();
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const mcpOptions = { timeout: 15_000 };
    await verifyMcpToolsAndPrompts(client, mcpOptions);
    await verifyMcpReplay(client, mcpOptions, investigationReplay);
    await verifyMcpTargetFree(client, mcpOptions);
    await verifyMcpUnknownProvider(client, mcpOptions);
    await verifyMcpBinaryLifecycle(client, mcpOptions);
    await verifyMcpEvidenceBundle(client, mcpOptions, evidenceRoot);
  } catch (cause) {
    throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
  } finally {
    await client.close();
    await transport.close();
  }
}

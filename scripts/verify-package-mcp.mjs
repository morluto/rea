import assert from "node:assert/strict";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_STARTUP_POLICY } from "../dist/mcpStartupPolicy.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import * as prompts from "./verify-package-prompts.mjs";
import { json, verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";

const execute = promisify(execFile);

const verifyMcpToolsAndPrompts = async (client, mcpOptions) => {
  await verifyCompleteToolCatalog(client, mcpOptions);
  await prompts.verifyPromptCatalog(client, mcpOptions, prompts.names);
  await prompts.verifyPromptCompletion(client, mcpOptions, false);
};

const verifyMcpTargetFree = async (client, mcpOptions) => {
  const status = await client.callTool(
    { name: "binary_session", arguments: {} },
    mcpOptions,
  );
  const currentDocument =
    status.structuredContent?.result?.tool_availability?.find(
      ({ name }) => name === "current_document",
    );
  if (
    currentDocument?.available !== false ||
    currentDocument.reason !== "target_required"
  )
    throw new Error(
      "packaged target-free MCP omitted target-bound availability metadata",
    );
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
        { name: "binary_session", arguments: {} },
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

const verifyMcpLinuxToolAvailability = async (client, mcpOptions) => {
  const current = await client.callTool(
    { name: "current_document", arguments: {} },
    mcpOptions,
  );
  if (current.isError !== true)
    throw new Error("packaged Linux MCP executed an unavailable Hopper tool");
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
  if (process.platform === "linux") {
    await verifyMcpLinuxToolAvailability(client, mcpOptions);
  } else {
    const current = await client.callTool(
      { name: "current_document", arguments: {} },
      mcpOptions,
    );
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

const verifyMcpInlineArtifactEvidence = async (
  client,
  mcpOptions,
  artifactArchive,
) => {
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: artifactArchive } },
    mcpOptions,
  );
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  try {
    const inspected = await client.callTool(
      { name: "inspect_artifact", arguments: {} },
      mcpOptions,
    );
    assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
    const source = parseEvidence(inspected.structuredContent?.evidence);
    assert.deepEqual(
      source.normalized_result,
      inspected.structuredContent?.result,
    );
    assert.deepEqual(
      json(prompts.mcpText(inspected)),
      inspected.structuredContent,
    );
    const compared = await client.callTool(
      {
        name: "compare_artifacts",
        arguments: {
          left: inspected.structuredContent.evidence,
          right: inspected.structuredContent.evidence,
        },
      },
      mcpOptions,
    );
    assert.notEqual(compared.isError, true, JSON.stringify(compared));
    const comparison = parseEvidence(compared.structuredContent?.evidence);
    assert.deepEqual(
      comparison.normalized_result,
      compared.structuredContent?.result,
    );
    assert.ok(comparison.evidence_links.includes(source.evidence_id));
    const bundle = await client.callTool(
      { name: "get_evidence_bundle", arguments: {} },
      mcpOptions,
    );
    assert.notEqual(bundle.isError, true, JSON.stringify(bundle));
    for (const evidence of [source, comparison]) {
      assert.deepEqual(
        bundle.structuredContent?.result?.records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        ),
        evidence,
      );
    }
  } finally {
    const closed = await client.callTool(
      { name: "close_binary", arguments: {} },
      mcpOptions,
    );
    assert.notEqual(closed.isError, true, JSON.stringify(closed));
  }
};

/** Connect to the packaged MCP server and verify catalog and Evidence composition. */
export async function verifyPackageMcp({
  cli,
  environment,
  evidenceRoot,
  artifactArchive,
}) {
  const diagnosed = json(
    (
      await execute(cli, ["mcp", "doctor", "--json"], {
        env: environment,
        timeout: MCP_STARTUP_POLICY.doctorDeadlineMs,
      })
    ).stdout,
  );
  if (
    diagnosed.healthy !== true ||
    diagnosed.inventory?.tools?.observed !==
      diagnosed.inventory?.tools?.expected
  )
    throw new Error("packaged production MCP doctor failed");
  const transport = new StdioClientTransport({
    command: cli,
    args: ["mcp"],
    env: {
      ...environment,
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
    await verifyMcpTargetFree(client, mcpOptions);
    await verifyMcpUnknownProvider(client, mcpOptions);
    await verifyMcpBinaryLifecycle(client, mcpOptions);
    await verifyMcpInlineArtifactEvidence(client, mcpOptions, artifactArchive);
    await verifyMcpEvidenceBundle(client, mcpOptions, evidenceRoot);
  } catch (cause) {
    throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
  } finally {
    await client.close();
    await transport.close();
  }
}

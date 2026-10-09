import { parseConfig } from "../../../src/config.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisProvider,
  type CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { readAnalysisSnapshot } from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";

const identity = { id: "fixture", name: "Fixture", version: "1" } as const;
const profile = createAnalysisProfile(identity, { fixture: true });
const operations = [
  "list_segments",
  "list_documents",
  "list_procedures",
  "list_strings",
] as const;

const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("MCP composed workflow snapshot replay", () => {
  it("exports an MCP workflow binding and replays its Evidence without provider startup or calls", async () => {
    const directory = await createTestTempDirectory(
      "rea-mcp-workflow-snapshot-",
    );
    const targetPath = join(directory, "fixture.hop");
    const snapshotPath = join(directory, "analysis.json");
    await writeFile(targetPath, "fixture binary");
    const starts: string[] = [];
    const calls: string[] = [];
    const provider = makeProvider(starts, calls);
    const session = createTestBinarySession(provider, {
      resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
    });
    const server = createServer(session, session, { logger: silentLogger });
    const mcp = new Client({ name: "workflow-snapshot", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: targetPath },
    });
    expect(opened.isError).not.toBe(true);
    const analyzed = await mcp.callTool({
      name: "binary_overview",
      arguments: {},
    });
    expect(analyzed.isError, JSON.stringify(analyzed.content)).not.toBe(true);
    const output = toolContract("binary_overview").outputSchema.parse(
      analyzed.structuredContent,
    );
    const workflowEvidence = z
      .object({
        operation: z.literal("binary_overview"),
        analysis_profile: z.object({ digest: z.string() }),
      })
      .passthrough()
      .parse(output);
    const afterAnalysisCalls = [...calls];
    const afterAnalysisStarts = [...starts];

    const closed = await mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: snapshotPath },
    });
    expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);
    const snapshot = await readAnalysisSnapshot(snapshotPath);
    if (!snapshot.ok) throw snapshot.error;
    const receipt = toolContract("close_binary").outputSchema.parse(
      closed.structuredContent,
    ).result;
    expect(receipt).toMatchObject({
      path: snapshotPath,
      primitive_entries: snapshot.value.entries.length,
      workflow_entries: snapshot.value.workflow_entries.length,
      evidence_records: snapshot.value.evidence_bundle.records.length,
    });
    expect(snapshot.value.workflow_entries).toHaveLength(1);
    expect(snapshot.value.evidence_bundle.records).toContainEqual(
      expect.objectContaining({
        evidence_id: workflowEvidence.evidence_id,
        operation: "binary_overview",
      }),
    );

    const dependencies: DirectAnalysisDependencies = {
      readConfiguration: () => parseConfig({}),
      createBinarySession: () =>
        createTestBinarySession(provider, {
          resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
        }),
      createManagedBinarySession: () =>
        createTestBinarySession(provider, {
          resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
        }),
    };
    const replay = await runDirectAnalysis(
      dependencies,
      targetPath,
      "binary_overview",
      {},
      { snapshotPath },
    );

    expect(replay).toEqual(output);
    expect(calls).toEqual(afterAnalysisCalls);
    expect(starts).toEqual(afterAnalysisStarts);
  });

  it("does not bind a workflow when an upstream operation is live", async () => {
    const directory = await createTestTempDirectory(
      "rea-mcp-live-workflow-snapshot-",
    );
    const targetPath = join(directory, "fixture.hop");
    const snapshotPath = join(directory, "analysis.json");
    await writeFile(targetPath, "fixture binary");
    const starts: string[] = [];
    const calls: string[] = [];
    const session = createTestBinarySession(
      makeProvider(starts, calls, "list_strings"),
      {
        resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
      },
    );
    const server = createServer(session, session, { logger: silentLogger });
    const mcp = new Client({
      name: "live-workflow-snapshot",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    expect(
      (
        await mcp.callTool({
          name: "open_binary",
          arguments: { path: targetPath },
        })
      ).isError,
    ).not.toBe(true);
    const analyzed = await mcp.callTool({
      name: "binary_overview",
      arguments: {},
    });
    expect(analyzed.isError, JSON.stringify(analyzed.content)).not.toBe(true);
    expect(
      toolContract("binary_overview").outputSchema.parse(
        analyzed.structuredContent,
      ),
    ).toMatchObject({ operation: "binary_overview" });
    const closed = await mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: snapshotPath },
    });
    expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);

    const snapshot = await readAnalysisSnapshot(snapshotPath);
    if (!snapshot.ok) throw snapshot.error;
    expect(snapshot.value.workflow_entries).toEqual([]);
  });
});

const makeProvider = (
  starts: string[],
  calls: string[],
  liveOperation?: (typeof operations)[number],
): AnalysisProvider => {
  const capabilities: CapabilityDescriptor[] = operations.map((operation) => ({
    operation,
    provider: identity,
    available: true,
    reason: null,
    cachePolicy: operation === liveOperation ? "live" : "snapshot",
    effects: {
      mutatesArtifact: false,
      launchesProcess: true,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  }));
  return {
    identity: () => identity,
    capabilities: () => capabilities,
    resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
    createClient: () => {
      starts.push("start");
      return {
        execute: async (operation) => {
          calls.push(operation);
          const result =
            operation === "health"
              ? null
              : operation === "list_segments"
                ? [{ name: "__TEXT", start: "0x1000", end: "0x2000" }]
                : operation === "list_documents"
                  ? ["fixture"]
                  : operation === "list_procedures"
                    ? ["0x1000"]
                    : { "0x1000": "fixture" };
          return ok(createAnalysisExecution(result, identity));
        },
        close: () => Promise.resolve(ok(null)),
      };
    },
  };
};

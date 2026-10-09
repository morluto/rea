import { parseConfig } from "../../../src/config/parseConfig.js";
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
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
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

describe("MCP composed workflow target admission", () => {
  it("keeps a composed result and snapshot on its admitted target across queued close and open", async () => {
    const { targetPaths, snapshotPath } = await createWorkflowFiles(
      "rea-mcp-admitted-workflow-",
      ["first.hop", "second.hop"],
    );
    const firstPath = targetPaths[0];
    const secondPath = targetPaths[1];
    if (firstPath === undefined || secondPath === undefined)
      throw new Error("Expected two workflow targets");
    const starts: string[] = [];
    const calls: string[] = [];
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const session = createWorkflowSession(
      makeProvider(starts, calls, undefined, { entered, release }),
    );
    const { mcp } = await connectWorkflowMcp(session, "admitted-workflow");
    const closeStarted = createDeferred<void>();
    mcp.setNotificationHandler("notifications/progress", () => {
      closeStarted.resolve();
    });
    await openWorkflowTarget(mcp, firstPath);

    const analysisRequest = mcp.callTool({
      name: "binary_overview",
      arguments: {},
    });
    await entered.promise;
    const closeRequest = mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: snapshotPath },
      _meta: { progressToken: "close-race" },
    });
    await closeStarted.promise;
    const openRequest = mcp.callTool({
      name: "open_binary",
      arguments: { path: secondPath },
    });
    release.resolve();

    const analyzed = await analysisRequest;
    expect(analyzed.isError, JSON.stringify(analyzed.content)).not.toBe(true);
    const evidence = toolContract("binary_overview").outputSchema.parse(
      analyzed.structuredContent,
    );
    expect(evidence.analysis_profile).not.toBeNull();
    expect(evidence).toMatchObject({ subject: { local_path: firstPath } });
    const closed = await closeRequest;
    expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);
    const snapshot = await readAnalysisSnapshot(snapshotPath);
    if (!snapshot.ok) throw snapshot.error;
    expect(snapshot.value.workflow_entries).toHaveLength(1);
    expect(snapshot.value.evidence_bundle.records).toContainEqual(
      expect.objectContaining({
        operation: "binary_overview",
        subject: expect.objectContaining({ local_path: firstPath }),
      }),
    );
    const opened = await openRequest;
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    expect(session.activeTarget()?.path).toBe(secondPath);
  });
});

describe("MCP composed workflow snapshot replay", () => {
  it("exports an MCP workflow binding and replays its Evidence without provider startup or calls", async () => {
    const { targetPaths, snapshotPath } = await createWorkflowFiles(
      "rea-mcp-workflow-snapshot-",
      ["fixture.hop"],
    );
    const targetPath = targetPaths[0];
    if (targetPath === undefined) throw new Error("Expected a workflow target");
    const starts: string[] = [];
    const calls: string[] = [];
    const provider = makeProvider(starts, calls);
    const session = createWorkflowSession(provider);
    const { mcp } = await connectWorkflowMcp(session, "workflow-snapshot");

    await openWorkflowTarget(mcp, targetPath);
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
      createBinarySession: () => createWorkflowSession(provider),
      createManagedBinarySession: () => createWorkflowSession(provider),
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
    const { targetPaths, snapshotPath } = await createWorkflowFiles(
      "rea-mcp-live-workflow-snapshot-",
      ["fixture.hop"],
    );
    const targetPath = targetPaths[0];
    if (targetPath === undefined) throw new Error("Expected a workflow target");
    const starts: string[] = [];
    const calls: string[] = [];
    const session = createWorkflowSession(
      makeProvider(starts, calls, "list_strings"),
    );
    const { mcp } = await connectWorkflowMcp(session, "live-workflow-snapshot");

    await openWorkflowTarget(mcp, targetPath);
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

const createWorkflowFiles = async (
  prefix: string,
  filenames: readonly string[],
): Promise<{
  readonly targetPaths: readonly string[];
  readonly snapshotPath: string;
}> => {
  const directory = await createTestTempDirectory(prefix);
  const targetPaths = await Promise.all(
    filenames.map(async (filename) => {
      const path = join(directory, filename);
      await writeFile(path, filename);
      return path;
    }),
  );
  return { targetPaths, snapshotPath: join(directory, "analysis.json") };
};

const createWorkflowSession = (provider: AnalysisProvider) =>
  createTestBinarySession(provider, {
    resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
  });

const connectWorkflowMcp = async (
  session: ReturnType<typeof createWorkflowSession>,
  clientName: string,
): Promise<{ readonly mcp: Client }> => {
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: clientName, version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server);
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return { mcp };
};

const openWorkflowTarget = async (mcp: Client, path: string): Promise<void> => {
  const opened = await mcp.callTool({
    name: "open_binary",
    arguments: { path },
  });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
};

const makeProvider = (
  starts: string[],
  calls: string[],
  liveOperation?: (typeof operations)[number],
  pause?: {
    readonly entered: ReturnType<typeof createDeferred<void>>;
    readonly release: ReturnType<typeof createDeferred<void>>;
  },
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
          if (operation === "list_documents" && pause !== undefined) {
            pause.entered.resolve();
            await pause.release.promise;
          }
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

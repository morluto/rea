import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { probeProcessCaptureCapability } from "../../../src/application/ProcessHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import {
  createSessionMcpHarness,
  snapshotAndRecordUnknown,
} from "./sessionMcpHarness.js";

const SNAPSHOT_PROFILE = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  { fixture: true },
);

const resources: Array<{ close(): Promise<unknown> }> = [];
const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
);
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("target-free MCP lifecycle", () => {
  it("reopens replaced content at one canonical path through MCP", async () => {
    directory = await createTestTempDirectory("rea-mcp-replaced-target-");
    const targetPath = join(directory, "mutable.hop");
    await writeFile(targetPath, "first");
    const closed: string[] = [];
    const session = createTestBinarySession(provider(closed), {
      resolveAnalysisProfile: () =>
        Promise.resolve(
          resultOk({ profile: SNAPSHOT_PROFILE, compatibility: {} }),
        ),
    });
    const server = createServer(session, session, { logger: silentLogger });
    const mcp = new Client({ name: "replaced-target", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const first = structured(
      await mcp.callTool({
        name: "open_binary",
        arguments: { path: targetPath },
      }),
    ).result;
    await writeFile(targetPath, "second");
    const second = structured(
      await mcp.callTool({
        name: "open_binary",
        arguments: { path: targetPath },
      }),
    ).result;

    const canonicalTargetPath = await realpath(targetPath);
    expect(first).toMatchObject({ path: canonicalTargetPath });
    expect(second).toMatchObject({ path: canonicalTargetPath });
    expect(z.object({ sha256: z.string() }).parse(second).sha256).not.toBe(
      z.object({ sha256: z.string() }).parse(first).sha256,
    );
    expect(closed).toEqual([canonicalTargetPath]);
    expect(
      z
        .object({
          result: z.object({ path: z.string(), sha256: z.string() }),
        })
        .parse(
          structured(
            await mcp.callTool({
              name: "binary_session",
              arguments: {},
            }),
          ),
        ).result,
    ).toEqual({
      path: canonicalTargetPath,
      sha256: z.object({ sha256: z.string() }).parse(second).sha256,
    });
  }, 30_000);
});

describe("target-free MCP workflow", () => {
  it("reports no-target, opens, analyzes, switches, reports status, and closes", async () => {
    directory = await createTestTempDirectory("rea-mcp-session-");
    const lifecycle = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const { mcp, first, second, closed } = lifecycle;

    const beforeTools = (await mcp.listTools()).tools;
    const beforeNames = beforeTools.map(({ name }) => name);
    expect(mcp.getInstructions()).toContain(
      "Use the tool that directly answers the question",
    );
    expect(
      beforeTools.find(({ name }) => name === "inspect_artifact")?.description,
    ).toContain("Returns the complete content-addressed artifact graph");
    expect(beforeNames).toContain("open_binary");
    expect(beforeNames).toContain("binary_session");
    expect(beforeNames).toContain("current_document");
    expect(beforeNames).toContain("capture_process_scenario");
    expect(
      (await mcp.callTool({ name: "open_binary", arguments: { path: first } }))
        .isError,
    ).not.toBe(true);
    const openedStatus = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(openedStatus).toMatchObject({
      result: { path: await realpath(first) },
    });
    expect(
      z
        .object({
          result: z.object({
            capabilities: z.array(z.object({ operation: z.string() })),
          }),
        })
        .parse(openedStatus)
        .result.capabilities.map(({ operation }) => operation),
    ).not.toContain("inventory_artifact");
    expect(
      text(await mcp.callTool({ name: "current_document", arguments: {} })),
    ).toContain("first.hop");
    const { recordedUnknown } = await snapshotAndRecordUnknown(
      lifecycle,
      directory,
    );
    const resolved = await mcp.callTool({
      name: "update_unknown",
      arguments: {
        unknown_id: recordedUnknown.unknown_id,
        expected_revision: 1,
        status: "resolved",
        severity: "medium",
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        resolution: {
          disposition: "out-of-scope",
          rationale: "Operator explicitly excluded this branch from scope.",
          evidence_ids: [],
        },
      },
    });
    expect(resolved.isError).not.toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      structured(
        await mcp.callTool({
          name: "verify_unknown_resolution",
          arguments: { unknown_id: recordedUnknown.unknown_id },
        }),
      ).result,
    ).toMatchObject({ valid: true, truthVerified: false });
    await mcp.callTool({ name: "open_binary", arguments: { path: second } });
    expect(closed.some((path) => path.endsWith("first.hop"))).toBe(true);
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain("second.hop");
    const snapshotPath = join(directory, "analysis.json");
    expect(
      structured(
        await mcp.callTool({
          name: "close_binary",
          arguments: { snapshot_path: snapshotPath },
        }),
      ).result,
    ).toMatchObject({ path: snapshotPath, entries: 0 });
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toMatchObject({
      evidence_bundle: { records: [], unknowns: [] },
    });
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain('"open":false');
    expect(
      (
        await mcp.callTool({
          name: "open_binary",
          arguments: { path: first, snapshot_path: snapshotPath },
        })
      ).isError,
    ).toBe(true);
    expect(
      structured(await mcp.callTool({ name: "list_unknowns", arguments: {} }))
        .result,
    ).toMatchObject({ items: [] });
    expect(
      (
        await mcp.callTool({
          name: "open_binary",
          arguments: { path: second, snapshot_path: snapshotPath },
        })
      ).isError,
    ).not.toBe(true);
    await mcp.callTool({ name: "close_binary", arguments: {} });
  }, 10_000);
});

describe("session filesystem path boundaries over MCP", () => {
  it("rejects relative snapshot and export paths with an absolute-path error", async () => {
    directory = await createTestTempDirectory("rea-mcp-path-boundary-");
    const { mcp, first } = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );

    const exported = await mcp.callTool({
      name: "export_evidence_bundle",
      arguments: { path: "relative-bundle.json" },
    });
    expect(exported.isError, JSON.stringify(exported.content)).toBe(true);
    expect(JSON.stringify(exported.content)).toContain("absolute");

    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: first },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const closed = await mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: "relative-analysis.json" },
    });
    expect(closed.isError, JSON.stringify(closed.content)).toBe(true);
    expect(JSON.stringify(closed.content)).toContain("absolute");
    await mcp.callTool({ name: "close_binary", arguments: {} });
  }, 10_000);
});

describe("process residuals over MCP", () => {
  it("records process residuals linked to capture Evidence", async () => {
    if (!(await probeProcessCaptureCapability()).available) return;
    const session = createTestBinarySession(() => client("fixture", []));
    const server = createServer(session, session, {
      logger: silentLogger,
    });
    const mcp = new Client({ name: "process-unknown", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const captured = await mcp.callTool({
      name: "capture_process_scenario",
      arguments: {
        executable: process.execPath,
        arguments: [processFixture, "partial"],
      },
    });
    expect(captured.isError, text(captured)).not.toBe(true);
    const contract = toolContract("capture_process_scenario");
    const wire = (await mcp.listTools()).tools.find(
      ({ name }) => name === contract.name,
    );
    if (wire?.outputSchema === undefined)
      throw new Error("Missing process capture output schema");
    expect(
      new Ajv2020({ strict: false, validateFormats: false }).validate(
        z.record(z.string(), z.unknown()).parse(wire.outputSchema),
        captured.structuredContent,
      ),
    ).toBe(true);
    expect(
      contract.outputSchema.safeParse(captured.structuredContent).success,
    ).toBe(true);
    const listedUnknowns = await mcp.callTool({
      name: "list_unknowns",
      arguments: {},
    });
    expect(listedUnknowns.isError, text(listedUnknowns)).not.toBe(true);
    const listed = z
      .object({
        result: z.object({
          items: z.array(
            z.object({
              question: z.string(),
              domain: z.string(),
            }),
          ),
        }),
      })
      .parse(structured(listedUnknowns)).result.items;
    expect(listed).toContainEqual(
      expect.objectContaining({
        question: "Was network behavior fully observed during capture?",
        domain: "process-network",
      }),
    );
  });
});

const client = (path: string, closed: string[]): AnalysisClient => ({
  execute: (name) =>
    Promise.resolve(
      ok(name === "health" ? null : name === "current_document" ? path : null),
    ),
  close: () => {
    closed.push(path);
    return Promise.resolve();
  },
});

const provider = (closed: string[]): AnalysisProvider => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const capability: CapabilityDescriptor = {
    provider: identity,
    operation: "current_document",
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  };
  return {
    identity: () => identity,
    capabilities: () => [capability],
    createClient: (target) => client(target.path, closed),
  };
};

const text = (result: CallToolResult): string => {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing text result");
  return content.text;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error(
      `missing structured result: ${JSON.stringify(result.content)}`,
    );
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

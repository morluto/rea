import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BinarySession } from "../src/application/BinarySession.js";
import type { AnalysisClient } from "../src/application/AnalysisProvider.js";
import { probeProcessCaptureCapability } from "../src/application/ProcessHarness.js";
import { observed as ok } from "./fixtures/analysisExecution.js";
import { createServer } from "../src/server/createServer.js";
import {
  createEvidenceBundle,
  evidenceBundleSchema,
} from "../src/domain/evidenceBundle.js";
import { createEvidence } from "../src/domain/evidence.js";
import { silentLogger } from "../src/logger.js";
import { createAnalysisProfile } from "../src/domain/analysisProfile.js";
import { ok as resultOk } from "../src/domain/result.js";

const SNAPSHOT_PROFILE = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  1,
  { fixture: true },
);

const resources: Array<{ close(): Promise<unknown> }> = [];
const processFixture = fileURLToPath(
  new URL("./fixtures/processFidelity.mjs", import.meta.url),
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
    directory = await mkdtemp(join(tmpdir(), "rea-mcp-replaced-target-"));
    const targetPath = join(directory, "mutable.hop");
    await writeFile(targetPath, "first");
    const closed: string[] = [];
    const session = new BinarySession((target) => client(target.path, closed), {
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

    expect(first).toMatchObject({ path: targetPath });
    expect(second).toMatchObject({ path: targetPath });
    expect(z.object({ sha256: z.string() }).parse(second).sha256).not.toBe(
      z.object({ sha256: z.string() }).parse(first).sha256,
    );
    expect(closed).toEqual([targetPath]);
    expect(
      z
        .object({ result: z.object({ path: z.string(), sha256: z.string() }) })
        .parse(
          structured(
            await mcp.callTool({ name: "binary_session", arguments: {} }),
          ),
        ).result,
    ).toEqual({
      path: targetPath,
      sha256: z.object({ sha256: z.string() }).parse(second).sha256,
    });
  });

  it("reports no-target, opens, analyzes, switches, reports status, and closes", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-mcp-session-"));
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const closed: string[] = [];
    const session = new BinarySession((target) => client(target.path, closed), {
      resolveAnalysisProfile: () =>
        Promise.resolve(
          resultOk({ profile: SNAPSHOT_PROFILE, compatibility: {} }),
        ),
    });
    const server = createServer(session, session, {
      logger: silentLogger,
      evidenceFilePolicy: {
        roots: [directory],
        maxBytes: 1024 * 1024,
        maxDepth: 68,
        maxStringLength: 1024,
        maxNodes: 10_000,
      },
      analysisSnapshotFilePolicy: {
        roots: [directory],
        maxBytes: 1024 * 1024,
        maxDepth: 68,
        maxStringLength: 1024,
        maxNodes: 10_000,
      },
    });
    const mcp = new Client({ name: "session-test", version: "1.0.0" });
    let resourceListChanges = 0;
    mcp.setNotificationHandler("notifications/resources/list_changed", () => {
      resourceListChanges += 1;
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const before = await mcp.callTool({
      name: "current_document",
      arguments: {},
    });
    expect(before.isError).toBe(true);
    expect(text(before)).toBe(
      "No app is open. Ask the user which app to investigate, then call open_binary with its local path.",
    );
    expect((await mcp.listTools()).tools).toHaveLength(80);
    const deniedCapture = await mcp.callTool({
      name: "capture_process_scenario",
      arguments: {
        approved: true,
        executable: "/bin/sh",
        working_directory: "/tmp",
      },
    });
    expect(deniedCapture.isError).toBe(true);
    expect(structured(deniedCapture)).toMatchObject({
      error: {
        category: "permission_required",
      },
    });
    expect(text(deniedCapture)).toBe(
      "Process capture is disabled. Set `REA_PROCESS_CAPTURE_ENABLED=true`, configure approved roots, then restart REA.",
    );
    expect(
      (await mcp.callTool({ name: "open_binary", arguments: { path: first } }))
        .isError,
    ).not.toBe(true);
    expect(
      text(await mcp.callTool({ name: "current_document", arguments: {} })),
    ).toContain("first.hop");
    const exported = await mcp.callTool({
      name: "export_evidence_bundle",
      arguments: {},
    });
    const bundle = evidenceBundleSchema.parse(structured(exported).result);
    expect(bundle.records).toHaveLength(1);
    const evidencePath = join(directory, "evidence.json");
    expect(
      structured(
        await mcp.callTool({
          name: "export_evidence_bundle",
          arguments: { path: evidencePath },
        }),
      ).result,
    ).toMatchObject({ path: evidencePath, records: 1 });
    expect(
      structured(
        await mcp.callTool({
          name: "import_evidence_bundle",
          arguments: { path: evidencePath },
        }),
      ).result,
    ).toEqual({ imported: 0, total: 1 });
    const externalEvidencePath = join(directory, "external-evidence.json");
    await writeFile(
      externalEvidencePath,
      JSON.stringify(
        createEvidenceBundle([
          createEvidence(
            undefined,
            { id: "fixture", name: "Fixture", version: "1" },
            { operation: "external_observation", parameters: {}, result: true },
          ),
        ]),
      ),
    );
    let changesBeforeMutation = resourceListChanges;
    expect(
      structured(
        await mcp.callTool({
          name: "import_evidence_bundle",
          arguments: { path: externalEvidencePath },
        }),
      ).result,
    ).toEqual({ imported: 1, total: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resourceListChanges).toBe(changesBeforeMutation + 1);
    changesBeforeMutation = resourceListChanges;
    const recordedUnknown = z
      .object({
        result: z.object({
          unknown_id: z.string(),
          revision: z.number(),
        }),
      })
      .parse(
        structured(
          await mcp.callTool({
            name: "record_unknown",
            arguments: {
              approved: true,
              question: "Does the alternate branch execute?",
              severity: "medium",
              domain: "control-flow",
              required_authority: "controlled-replay",
              required_confidence: "observed",
              required_environment: null,
              recommended_probes: [],
              relationships: [],
            },
          }),
        ),
      ).result;
    expect(recordedUnknown.revision).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resourceListChanges).toBe(changesBeforeMutation + 1);
    expect(
      z
        .object({ result: z.array(z.unknown()) })
        .parse(
          structured(
            await mcp.callTool({ name: "list_unknowns", arguments: {} }),
          ),
        ).result,
    ).toHaveLength(1);
    const resolved = await mcp.callTool({
      name: "update_unknown",
      arguments: {
        approved: true,
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
    expect(resourceListChanges).toBe(changesBeforeMutation + 2);
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
    ).toContain('"open": false');
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
    ).toEqual([]);
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

  it("records approved process residuals in the unknown registry", async () => {
    if (!(await probeProcessCaptureCapability()).available) return;
    const session = new BinarySession(() => client("fixture", []));
    const server = createServer(session, session, {
      logger: silentLogger,
      processPolicy: {
        enabled: true,
        executableRoots: [dirname(process.execPath)],
        workingRoots: [dirname(processFixture)],
        allowedEnvironment: [],
        allowExternalNetwork: true,
      },
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
        approved: true,
        unknown_registry_approved: true,
        executable: process.execPath,
        arguments: [processFixture, "partial"],
        working_directory: dirname(processFixture),
        limits: { output_bytes: 1 },
      },
    });
    expect(captured.isError, text(captured)).not.toBe(true);
    const listed = z
      .object({
        result: z.array(z.object({ question: z.string(), domain: z.string() })),
      })
      .parse(
        structured(
          await mcp.callTool({ name: "list_unknowns", arguments: {} }),
        ),
      ).result;
    expect(listed).toContainEqual({
      question: "Was network behavior fully observed during capture?",
      domain: "process-network",
    });
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
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

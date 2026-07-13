import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { evidenceBundleSchema } from "../src/domain/evidenceBundle.js";
import { silentLogger } from "../src/logger.js";

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
  it("reports no-target, opens, analyzes, switches, reports status, and closes", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-mcp-session-"));
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const closed: string[] = [];
    const session = new BinarySession((target) => client(target.path, closed));
    const server = createServer(session, session, {
      logger: silentLogger,
      evidenceFilePolicy: {
        roots: [directory],
        maxBytes: 1024 * 1024,
        maxDepth: 68,
        maxStringLength: 1024,
        maxNodes: 10_000,
      },
    });
    const mcp = new Client({ name: "session-test", version: "1.0.0" });
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
    expect(text(before)).toContain("NoBinaryOpenError");
    expect((await mcp.listTools()).tools).toHaveLength(68);
    const deniedCapture = await mcp.callTool({
      name: "capture_process_scenario",
      arguments: {
        approved: true,
        executable: "/bin/sh",
        working_directory: "/tmp",
      },
    });
    expect(deniedCapture.isError).toBe(true);
    expect(text(deniedCapture)).toContain("process capture is disabled");
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
    await mcp.callTool({ name: "close_binary", arguments: {} });
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain('"open": false');
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
      question:
        "network: External network isolation is not enforced by this adapter.",
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

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { safeParseEvidence } from "../../../src/domain/evidenceValidation.js";
import { recoveryOmissionRemediation } from "../../../src/domain/analysisErrorProjection.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

it.each(["compact", "full"] as const)(
  "delivers authenticated but unretained provider Evidence inline (%s schema)",
  async (profile) => {
    const identity = {
      id: "fixture",
      name: "Fixture analysis provider",
      version: "1",
    };
    const target = join(
      await createTestTempDirectory("rea-evidence-refusal-"),
      "fixture.com",
    );
    await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(() => ({
      execute: async () =>
        ok(
          createAnalysisExecution("entry", identity, {
            limitations: ["fixture limitation"],
          }),
        ),
      close: async () => ok(null),
    }));
    const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
    const session = new BinarySession(router, records);
    const server = createServer(
      { kind: "session", session },
      {
        environment: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    );
    const client = new Client({ name: "unretained-evidence", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const definitions = new Map(
        (await client.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      const definition = definitions.get("address_name");
      if (definition === undefined)
        throw new Error("address_name was not advertised");
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path: target, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const result = await client.callTool(
        {
          name: "address_name",
          arguments: { address: "0x100", document: "fixture" },
        },
        { toolDefinition: definition },
      );
      expect(result.isError).toBe(true);
      const error = parseMcpToolError(result).error;
      expect(error.code).toBe("resource_constraint");
      expect(error.details).toMatchObject({
        operation: "record_evidence",
        resource: "capacity",
        partial_observation: {
          kind: "unretained-evidence",
          evidence: {
            operation: "address_name",
            normalized_result: "entry",
            provider: identity,
            limitations: ["fixture limitation"],
          },
        },
      });
      const partial = error.details?.partial_observation as {
        kind: string;
        evidence: unknown;
      };
      const authenticated = safeParseEvidence(partial.evidence);
      expect(authenticated.ok).toBe(true);
      if (!authenticated.ok) throw authenticated.error;
      expect(session.hasEvidence(authenticated.value.evidence_id)).toBe(false);
      expect(records.statistics().evidenceRecords).toBe(0);
      expect(error.remediation.action).toContain(
        "Unretained Evidence is not included in the exported investigation",
      );
      expect(error.remediation.action).toContain(
        "if present in this response, save it separately",
      );
      expect(error.details).not.toHaveProperty("evidence_reference");
      const bundle = await client.callTool({
        name: "get_evidence_bundle",
        arguments: { detail: "complete" },
      });
      expect(bundle.isError).not.toBe(true);
      expect(bundle.structuredContent).toMatchObject({
        result: { records: [] },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

it("keeps an oversized unretained observation failure bounded and the connection usable", async () => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  };
  const target = join(
    await createTestTempDirectory("rea-evidence-overflow-"),
    "fixture.com",
  );
  await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const value = "x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536);
  const router = createTestProviderRouter(() => ({
    execute: async () => ok(createAnalysisExecution(value, identity)),
    close: async () => ok(null),
  }));
  const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
  const session = new BinarySession(router, records);
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "unretained-evidence-overflow",
    version: "1",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path: target, format: "dos-com" },
        })
      ).isError,
    ).not.toBe(true);
    const result = await client.callTool(
      {
        name: "address_name",
        arguments: { address: "0x100", document: "fixture" },
      },
      { timeout: 120000 },
    );
    expect(result.isError).toBe(true);
    const error = parseMcpToolError(result).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "record_evidence",
        resource: "capacity",
        reported_limits: { maximum_representation_bytes: 0 },
        partial_observation_omitted: {
          reason: "mcp-response-limit",
          constraint: "receive-buffer",
          retention: "unretained",
        },
      },
    });
    expect(error.remediation.action).toContain(
      recoveryOmissionRemediation("unretained"),
    );
    expect(error.remediation.action).toContain(
      "if present in this response, save it separately",
    );
    expect(error.details).not.toHaveProperty("partial_observation");
    expect(error.details).not.toHaveProperty("evidence_reference");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    expect(records.statistics().evidenceRecords).toBe(0);
    expect(
      (
        await client.callTool({
          name: "get_evidence_bundle",
          arguments: { detail: "summary" },
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
}, 120000);

it("bounds fallback when the retention error itself has oversized diagnostics", async () => {
  const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
  const evidence = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "address_name", parameters: {}, result: "entry" },
    { immutable: true },
  );
  const refused = records.recordEvidence(evidence);
  if (refused.ok) throw new Error("Expected retention refusal");
  refused.error.retainDiagnostics({
    oversized: "x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536),
  });
  const delivery = createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  const server = new EvidenceMcpServer(
    { name: "retention-overflow", version: "1" },
    { capabilities: {} },
    (record) => records.recordEvidence(record),
    delivery,
  );
  server.registerTool(
    "large_retention_failure",
    { inputSchema: z.object({}) },
    async () => delivery.toErrorToolResult(refused.error, true),
  );
  const client = new Client({ name: "retention-overflow", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const result = await client.callTool({
      name: "large_retention_failure",
      arguments: {},
    });
    const error = parseMcpToolError(result).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        reported_limits: {
          boundary: "mcp-response",
          original_error_code: "resource_constraint",
          retention: "failed",
          retention_error: { code: "resource_constraint" },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    expect(records.statistics().evidenceRecords).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
}, 120000);

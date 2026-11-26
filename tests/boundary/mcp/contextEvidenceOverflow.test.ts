import { inspectCapacityContext } from "../../support/mcp/addressContextCapacity.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createFixtureProviderIdentity } from "../../fixtures/analysisExecution.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { err, ok } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createServer } from "../../../src/server/createServer.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const verifyContext = (
  content: unknown,
  twoLarge: boolean,
  session: BinarySession,
): void => {
  expect(content).toMatchObject({
    result: {
      name: { state: "available", value: "entry" },
      procedure: {
        state: "unavailable",
        error: {
          code: "resource_constraint",
          details: {
            partial_observation_omitted: {
              reason: "mcp-response-limit",
              retention: "unretained",
              original_response_bytes_at_least: expect.any(Number),
              evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
            },
          },
        },
      },
    },
  });
  const procedureDetails = (
    content as {
      result: {
        procedure: {
          error: {
            details: {
              partial_observation_omitted: { evidence_id: string };
            };
          };
        };
      };
    }
  ).result.procedure.error.details;
  expect(procedureDetails).not.toHaveProperty("partial_observation");
  expect(procedureDetails).not.toHaveProperty("evidence_reference");
  expect(
    session.hasEvidence(
      procedureDetails.partial_observation_omitted.evidence_id,
    ),
  ).toBe(false);
  const smallFacet = twoLarge ? "inline_comment" : "comment";
  expect(content).toMatchObject({
    result: {
      [smallFacet]: {
        state: "unavailable",
        error: {
          code: "resource_constraint",
          details: {
            partial_observation: {
              kind: "unretained-evidence",
              evidence: {
                operation: smallFacet,
                normalized_result: "short note",
              },
            },
          },
        },
      },
      ...(twoLarge
        ? {
            comment: {
              state: "unavailable",
              error: {
                details: {
                  partial_observation_omitted: {
                    reason: "mcp-response-limit",
                    retention: "unretained",
                  },
                },
              },
            },
          }
        : {}),
    },
  });
};

mcpTest.for([
  ["compact", false],
  ["compact", true],
] as const)(
  "keeps context and smaller partials when unretained observations exceed the MCP budget (%s, two large=%s)",
  async ([profile, twoLarge], { mcp, onTestFinished }) => {
    const { client, response, session } = await inspectCapacityContext(
      mcp,
      onTestFinished,
      {
        REA_MCP_TOOL_FAMILIES: "session",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
      },
      {
        procedureName: "f".repeat(6 * 1024 * 1024),
        comment: twoLarge ? "g".repeat(6 * 1024 * 1024) : "short note",
        ...(twoLarge ? { inline_comment: "short note" } : {}),
      },
    );
    verifyContext(response.structuredContent, twoLarge, session);
    const bundle = await client.callTool({
      name: "get_evidence_bundle",
      arguments: { detail: "complete" },
    });
    expect(bundle.structuredContent).toMatchObject({
      result: {
        records: [{ operation: "address_name", normalized_result: "entry" }],
      },
    });
  },
);

it.each([true, false])(
  "recovers retained context facets when possible (profile=%s)",
  async (profile) => {
    const identity = createFixtureProviderIdentity();
    const target = join(
      await createTestTempDirectory("rea-context-oversize-success-"),
      "fixture.com",
    );
    await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(
      () => ({
        execute: async (operation) =>
          operation === "health"
            ? ok(createAnalysisExecution(null, identity))
            : operation === "address_name"
              ? ok(
                  createAnalysisExecution(
                    "x".repeat(6 * 1024 * 1024),
                    identity,
                  ),
                )
              : err(
                  new AnalysisCapabilityUnavailableError(
                    identity.id,
                    operation,
                    "not provided",
                  ),
                ),
        close: async () => ok(null),
      }),
      profile
        ? {
            resolveAnalysisProfile: async () =>
              ok({
                profile: createAnalysisProfile(identity, { fixture: true }),
              }),
          }
        : {},
    );
    const session = new BinarySession(router);
    const server = createServer(
      { kind: "session", session },
      { environment: { ...process.env, REA_MCP_TOOL_FAMILIES: "session" } },
    );
    const client = new Client(
      {
        name: "context-oversize-success",
        version: "1",
      },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: target, format: "dos-com" },
      });
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
      const result = await client.callTool({
        name: "inspect_address_context",
        arguments: { address: "0x100", document: "fixture" },
      });
      expect(result.isError).toBe(true);
      const error = parseMcpToolError(result).error;
      expect(error).toMatchObject({
        code: "resource_constraint",
        details: { reported_limits: { boundary: "mcp-response" } },
      });
      expect(error.remediation.action).toContain("get_evidence_bundle");
      expect(error.remediation.action).toContain("export_evidence_bundle");
      expect(error.remediation.action).toContain("may not have been retained");
      const advertised = new Set(
        (await client.listTools()).tools.map((tool) => tool.name),
      );
      expect(advertised.has("get_evidence_bundle")).toBe(true);
      expect(advertised.has("export_evidence_bundle")).toBe(true);
      expect(advertised.has("address_name")).toBe(false);
      const summary = await client.callTool({
        name: "get_evidence_bundle",
        arguments: {
          detail: "summary",
          filters: { operation: "address_name" },
        },
      });
      expect(summary.isError).not.toBe(true);
      expect(summary.structuredContent).toMatchObject({
        result: { matching_records: profile ? 1 : 0 },
      });
      const path = join(
        await createTestTempDirectory("rea-context-recover-"),
        "evidence.json",
      );
      const exported = await client.callTool({
        name: "export_evidence_bundle",
        arguments: { path },
      });
      expect(exported.isError).not.toBe(true);
      const bundle = JSON.parse(await readFile(path, "utf8")) as {
        records: { operation: string; normalized_result: unknown }[];
      };
      const record = bundle.records.find(
        (entry) => entry.operation === "address_name",
      );
      if (profile)
        expect(record?.normalized_result).toBe("x".repeat(6 * 1024 * 1024));
      else expect(record).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

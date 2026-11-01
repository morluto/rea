import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

it.each(
  ["full", "compact"].flatMap((profile) =>
    ["large-source", "large-primary", "invalid-source"].map((mode) => ({
      profile,
      mode,
    })),
  ),
)(
  "keeps sibling context with $mode ($profile schema)",
  async ({ mode, profile }) => {
    const id = { id: "fixture", name: "Fixture", version: "1" };
    const original = createEvidence(
      undefined,
      id,
      {
        operation: "health",
        parameters: {},
        result:
          mode === "large-source"
            ? "s".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536)
            : "small source",
      },
      { immutable: true },
    );
    const source =
      mode === "invalid-source"
        ? { ...original, normalized_result: "tampered" }
        : original;
    const name =
      mode === "large-primary"
        ? "p".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536)
        : "primary function";
    const target = join(
      await createTestTempDirectory("rea-source-context-"),
      "fixture.com",
    );
    await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(() => ({
      execute: async (op) =>
        op === "health"
          ? ok(createAnalysisExecution(null, id))
          : op === "address_name"
            ? ok(createAnalysisExecution("entry", id))
            : op === "resolve_containing_procedure"
              ? ok(
                  createAnalysisExecution(
                    {
                      query_address: "0x100",
                      found: true,
                      procedure: {
                        address: "0x100",
                        name,
                        classification: null,
                        body: { available: false, reason: "not recorded" },
                      },
                    },
                    id,
                    { sourceEvidence: [source] },
                  ),
                )
              : err(
                  new AnalysisCapabilityUnavailableError(
                    id.id,
                    op,
                    "not provided",
                  ),
                ),
      close: async () => ok(null),
    }));
    const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
    const session = new BinarySession(router, records);
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          REA_MCP_TOOL_FAMILIES: "session",
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    );
    const client = new Client({ name: "source-context", version: "1" });
    const validation = createMcpSchemaValidation();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: target, format: "dos-com" },
      });
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "inspect_address_context",
      );
      if (tool?.outputSchema === undefined)
        throw new Error("Missing context output schema");
      expect(validation.assertions.validateSchema(tool.outputSchema)).toBe(
        true,
      );
      const result = await client.callTool(
        {
          name: "inspect_address_context",
          arguments: { address: "0x100", document: "fixture" },
        },
        { timeout: 120000, toolDefinition: tool },
      );
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(
        validation.assertions.validate(
          tool.outputSchema,
          result.structuredContent,
        ),
        JSON.stringify(validation.assertions.errors),
      ).toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: {
          name: { state: "available", value: "entry" },
          procedure: {
            state: "unavailable",
            error: {
              code:
                mode === "invalid-source"
                  ? "evidence_integrity_mismatch"
                  : "resource_constraint",
              details:
                mode === "large-source"
                  ? {
                      partial_observation_omitted: {
                        reason: "mcp-response-limit",
                      },
                      completed_observation: { kind: "unretained-evidence" },
                    }
                  : mode === "large-primary"
                    ? {
                        partial_observation: { kind: "unretained-evidence" },
                        completed_observation_omitted: {
                          reason: "mcp-response-limit",
                        },
                      }
                    : {
                        completed_observation: { kind: "unretained-evidence" },
                      },
            },
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
      validation.clear();
    }
  },
  120000,
);

it.each([false, true])(
  "retains a sibling source failure when cleanup fails (large source: %s)",
  async (large) => {
    const provider = { id: "fixture", name: "Fixture", version: "1" };
    const source = createEvidence(
      undefined,
      provider,
      {
        operation: "health",
        parameters: {},
        result: large
          ? "s".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536)
          : "source",
      },
      { immutable: true },
    );
    const target = join(
      await createTestTempDirectory("rea-mixed-context-"),
      "fixture.com",
    );
    await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const session = new BinarySession(
      createTestProviderRouter(() => ({
        execute: async (operation) =>
          operation === "health"
            ? ok(createAnalysisExecution(null, provider))
            : operation === "address_name"
              ? ok(
                  createAnalysisExecution("completed name", provider, {
                    sourceEvidence: [source],
                  }),
                )
              : operation === "comment"
                ? err(
                    new ProviderCleanupError(
                      provider.id,
                      ["fixture-owner"],
                      {},
                    ),
                  )
                : err(
                    new AnalysisCapabilityUnavailableError(
                      provider.id,
                      operation,
                      "not provided",
                    ),
                  ),
        close: async () => ok(null),
      })),
      new InvestigationRecords({ maximumRepresentationBytes: 0 }),
    );
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "source-cleanup-context", version: "1" });
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
          name: "inspect_address_context",
          arguments: { address: "0x100", document: "fixture" },
        },
        { timeout: 120000 },
      );
      const error = parseMcpToolError(result).error;
      expect(error).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: ["fixture-owner"],
          secondary_failures: [
            {
              code: "resource_constraint",
              details: {
                ...(large
                  ? {
                      partial_observation_omitted: {
                        reason: "mcp-response-limit",
                      },
                    }
                  : {
                      partial_observation: {
                        kind: "unretained-evidence",
                        evidence: { evidence_id: source.evidence_id },
                      },
                    }),
                completed_observation: {
                  kind: "unretained-evidence",
                  evidence: { normalized_result: "completed name" },
                  source_closure: "not-established",
                },
              },
            },
          ],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
  120000,
);

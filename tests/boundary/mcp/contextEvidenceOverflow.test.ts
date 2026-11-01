import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { err, ok } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createServer } from "../../../src/server/createServer.js";

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

it.each([
  ["compact", false],
  ["full", false],
  ["compact", true],
] as const)(
  "keeps context and smaller partials when unretained observations exceed the MCP budget (%s, two large=%s)",
  async (profile, twoLarge) => {
    const identity = {
      id: "fixture",
      name: "Fixture analysis provider",
      version: "1",
    };
    const directory = await createTestTempDirectory("rea-context-capacity-");
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(
      () => ({
        execute: async (operation) => {
          if (operation === "address_name")
            return ok(createAnalysisExecution("entry", identity));
          if (operation === "comment")
            return ok(
              createAnalysisExecution(
                twoLarge ? "g".repeat(6 * 1024 * 1024) : "short note",
                identity,
              ),
            );
          if (operation === "inline_comment" && twoLarge)
            return ok(createAnalysisExecution("short note", identity));
          if (operation === "resolve_containing_procedure")
            return ok(
              createAnalysisExecution(
                {
                  query_address: "0x100",
                  found: true,
                  procedure: {
                    address: "0x100",
                    name: "f".repeat(6 * 1024 * 1024),
                    classification: null,
                    body: { available: false, reason: "not recorded" },
                  },
                },
                identity,
              ),
            );
          return err(
            new AnalysisCapabilityUnavailableError(
              identity.id,
              operation,
              "not provided",
            ),
          );
        },
        close: async () => ok(null),
      }),
      {
        resolveAnalysisProfile: async () =>
          ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
      },
    );
    const records = new InvestigationRecords({
      maximumRepresentationBytes: 8000,
    });
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
    const client = new Client({ name: "context-capacity", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const definitions = new Map(
        (await client.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      const call = (name: string, args: Record<string, string>) => {
        const toolDefinition = definitions.get(name);
        if (toolDefinition === undefined)
          throw new Error(`Tool ${name} was not advertised`);
        return client.callTool({ name, arguments: args }, { toolDefinition });
      };
      expect(
        (
          await call("open_binary", {
            path: target,
            format: "dos-com",
            provider_id: "fixture",
          })
        ).isError,
      ).not.toBe(true);
      const arguments_ = { document: "fixture", address: "0x100" };
      const response = await call("inspect_address_context", arguments_);
      expect(response.isError).not.toBe(true);
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
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

it("gives a usable MCP recovery when a successful context facet itself is oversized", async () => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  };
  const target = join(
    await createTestTempDirectory("rea-context-oversize-success-"),
    "fixture.com",
  );
  await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(() => ({
    execute: async (operation) =>
      operation === "health"
        ? ok(createAnalysisExecution(null, identity))
        : operation === "address_name"
          ? ok(createAnalysisExecution("x".repeat(6 * 1024 * 1024), identity))
          : err(
              new AnalysisCapabilityUnavailableError(
                identity.id,
                operation,
                "not provided",
              ),
            ),
    close: async () => ok(null),
  }));
  const session = new BinarySession(router);
  const server = createServer(
    { kind: "session", session },
    { environment: { ...process.env, REA_MCP_TOOL_FAMILIES: "session" } },
  );
  const client = new Client({ name: "context-oversize-success", version: "1" });
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
    expect(error.remediation.action).toContain("individually");
    expect(error.remediation.action).not.toContain("CLI");
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

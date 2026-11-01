import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { err, ok } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";

it.each(["compact", "full"] as const)(
  "preserves retained siblings and capacity recovery (%s schema)",
  async (profile) => {
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
          if (operation === "resolve_containing_procedure")
            return ok(
              createAnalysisExecution(
                {
                  query_address: "0x100",
                  found: true,
                  procedure: {
                    address: "0x100",
                    name: "f".repeat(16000),
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
        environment: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
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
      const contract = SESSION_TOOL_CONTRACTS.find(
        (
          candidate,
        ): candidate is Extract<
          (typeof SESSION_TOOL_CONTRACTS)[number],
          { readonly name: "inspect_address_context" }
        > => candidate.name === "inspect_address_context",
      );
      if (contract === undefined)
        throw new Error("inspect_address_context contract is missing");
      const context = contract.outputSchema.parse(
        response.structuredContent,
      ).result;
      const direct = await call("resolve_containing_procedure", arguments_);
      expect(direct.isError).toBe(true);
      const expected = parseMcpToolError(direct).error;
      expect(expected.code).toBe("resource_constraint");
      expect(expected.details).toMatchObject({
        partial_observation: {
          kind: "unretained-evidence",
          evidence: {
            operation: "resolve_containing_procedure",
            normalized_result: { found: true, query_address: "0x100" },
          },
        },
      });
      expect(context.name).toEqual({ state: "available", value: "entry" });
      expect(context.procedure).toEqual({
        state: "unavailable",
        reason: expected.message,
        remediation: expected.remediation.action,
        error: expected,
      });
      expect(records.statistics().evidenceRecords).toBe(1);
      expect(session.immutableEvidenceBundle().records[0]).toMatchObject({
        operation: "address_name",
        normalized_result: "entry",
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

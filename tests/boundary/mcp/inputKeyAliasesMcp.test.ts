import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES } from "../../../src/config/mcpInputSchemaProfile.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { ok } from "../../../src/domain/result.js";

interface Received {
  readonly tool: string;
  readonly args: unknown;
}

// The handlers only record the arguments the SDK validated; output schemas are
// left out so an empty result is accepted.
const connectCatalog = async (compact: boolean) => {
  const server = new EvidenceMcpServer(
    { name: "input-key-aliases", version: "0" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    compact ? { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES } : undefined,
  );
  const received: Received[] = [];
  for (const contract of TOOL_CONTRACTS) {
    const { outputSchema: _output, ...options } =
      toolRegistrationOptions(contract);
    server.registerTool(contract.name, options, async (args: unknown) => {
      received.push({ tool: contract.name, args });
      return { content: [] };
    });
  }
  const client = new Client({ name: "input-key-aliases", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    received,
    close: () => Promise.allSettled([client.close(), server.close()]),
  };
};

const errorText = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  JSON.stringify(result.content);

describe("MCP input key aliases", () => {
  for (const compact of [false, true])
    it(`accepts the aliases agents send ${compact ? "with" : "without"} the compact profile`, async () => {
      const { client, received, close } = await connectCatalog(compact);
      try {
        for (const [tool, args, expected] of [
          [
            "procedure_pseudo_code",
            { address: "0x401000" },
            { procedure: "0x401000" },
          ],
          [
            "read_function_instructions",
            { address: "0x401000" },
            { procedure: "0x401000" },
          ],
          ["search_strings", { query: "ACCESS" }, { pattern: "ACCESS" }],
        ] as const) {
          const result = await client.callTool({ name: tool, arguments: args });
          expect(result.isError, errorText(result)).toBeFalsy();
          expect(received.at(-1)).toMatchObject({ tool, args: expected });
          expect(received.at(-1)?.args).not.toHaveProperty(
            Object.keys(args)[0]!,
          );
        }
      } finally {
        await close();
      }
    });

  for (const compact of [false, true])
    it(`validates alias values before dispatch ${compact ? "with" : "without"} the compact profile`, async () => {
      const { client, received, close } = await connectCatalog(compact);
      try {
        for (const [tool, args] of [
          ["procedure_pseudo_code", { address: 42 }],
          ["search_strings", { query: "" }],
          ["annotate_native_function", { address: "0x401000" }],
        ] as const) {
          const result = await client.callTool({ name: tool, arguments: args });
          expect(result.isError, errorText(result)).toBe(true);
          expect(received).toEqual([]);
        }
      } finally {
        await close();
      }
    });

  it("still rejects an alias sent beside its canonical key and keeps other inputs unchanged", async () => {
    const { client, received, close } = await connectCatalog(false);
    try {
      const both = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { address: "0x401000", procedure: "main" },
      });
      expect(both.isError).toBe(true);
      expect(errorText(both)).toMatch(
        /Supply either procedure or address, not both/u,
      );
      const reverse = await client.callTool({
        name: "resolve_containing_procedure",
        arguments: { procedure: "0x401000" },
      });
      expect(reverse.isError).toBe(true);
      expect(received).toEqual([]);
    } finally {
      await close();
    }
  });

  for (const compact of [false, true])
    it(`advertises accepted aliases through SDK conversion with compact=${compact}`, async () => {
      const { client, close } = await connectCatalog(compact);
      try {
        const { tools } = await client.listTools();
        const ajv = new Ajv2020({ strict: false, validateFormats: false });
        for (const [tool, canonical, alias] of [
          ["procedure_pseudo_code", { procedure: "main" }, { address: "main" }],
          ["search_strings", { pattern: "ACCESS" }, { query: "ACCESS" }],
        ] as const) {
          const definition = tools.find(({ name }) => name === tool);
          expect(definition).toBeDefined();
          if (definition === undefined)
            throw new Error("Missing named contract");
          expect(definition.inputSchema.type).toBe("object");
          expect(ajv.validate(definition.inputSchema, canonical)).toBe(true);
          expect(ajv.validate(definition.inputSchema, alias)).toBe(true);
          for (const invalid of [
            tool === "procedure_pseudo_code"
              ? { document: "x" }
              : { mode: "literal" },
            { ...canonical, ...alias },
          ]) {
            expect(ajv.validate(definition.inputSchema, invalid)).toBe(false);
            const invalidReply = await client.callTool({
              name: tool,
              arguments: invalid,
            });
            expect(invalidReply.isError, errorText(invalidReply)).toBe(true);
          }
          const reply = await client.callTool({ name: tool, arguments: alias });
          expect(reply.isError, errorText(reply)).toBeFalsy();
        }
      } finally {
        await close();
      }
    });

  it("records canonical parameters in Evidence after an alias call", async () => {
    const providerCalls: { operation: string; input: unknown }[] = [];
    const harness = await connectGhidraMcp(
      "input-key-aliases-evidence-parameters",
      (operation, input) => {
        providerCalls.push({ operation, input });
        return Promise.resolve(
          ok({ value: "fixture pseudocode", limitations: [] }),
        );
      },
    );
    try {
      const call = async (args: Record<string, string>) => {
        const reply = await harness.mcp.callTool({
          name: "procedure_pseudo_code",
          arguments: args,
        });
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        return sessionEvidence(harness.session, reply.structuredContent);
      };
      const canonicalEvidence = await call({ procedure: "0x401000" });
      const aliasEvidence = await call({ address: "0x401000" });

      expect(providerCalls).toHaveLength(2);
      expect(providerCalls[0]).toEqual(providerCalls[1]);
      expect(providerCalls[0]).toMatchObject({
        operation: "procedure_pseudo_code",
        input: { procedure: "0x401000" },
      });
      expect(providerCalls[0]?.input).not.toHaveProperty("address");
      expect(aliasEvidence.parameters).toEqual({ procedure: "0x401000" });
      expect(aliasEvidence.parameters).not.toHaveProperty("address");
      expect(aliasEvidence).toMatchObject({
        operation: canonicalEvidence.operation,
        subject: canonicalEvidence.subject,
        provider: canonicalEvidence.provider,
        analysis_profile: canonicalEvidence.analysis_profile,
        raw_result: canonicalEvidence.raw_result,
        normalized_result: canonicalEvidence.normalized_result,
      });
    } finally {
      await harness.close();
    }
  });
});

describe("MCP input key alias descriptions", () => {
  it("names the canonical spelling instead of a key-based fallback in the full profile", async () => {
    const { client, close } = await connectCatalog(false);
    try {
      const { tools } = await client.listTools();
      for (const [tool, alias, canonical] of [
        ["procedure_pseudo_code", "address", "procedure"],
        ["search_strings", "query", "pattern"],
        ["search_bytes", "query", "pattern"],
      ] as const) {
        const properties = tools.find(({ name }) => name === tool)?.inputSchema
          .properties as Record<string, { description?: string }> | undefined;
        expect(properties?.[alias]?.description, tool).toBe(
          `Same as ${canonical}.`,
        );
        expect(properties?.[canonical]?.description, tool).toBeDefined();
      }
    } finally {
      await close();
    }
  });
});

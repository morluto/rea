import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { composeBinarySessionFromFactory } from "../../../src/application/BinarySessionComposition.js";
import type {
  AnalysisClient,
  AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort) => {
  const server = createServer(analysis);
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

it("executes a realistic workflow: list methods, decompile selected, get xrefs", async () => {
  const client = await connect({
    execute: (name, args) => {
      switch (name) {
        case "list_procedures":
          return Promise.resolve(
            ok({
              items: [
                { address: "0x1000", value: "main" },
                { address: "0x2000", value: "helper" },
              ],
              offset: 0,
              limit: 100,
              total: 2,
              next_offset: null,
              has_more: false,
            }),
          );
        case "procedure_pseudo_code":
          return Promise.resolve(
            ok(`pseudo for ${(args as { procedure: string }).procedure}`),
          );
        case "xrefs":
          return Promise.resolve(ok(["0x1000"]));
        default:
          return Promise.resolve(ok(null));
      }
    },
  });

  const listResult = await client.callTool({
    name: "list_procedures",
    arguments: {},
  });
  expect(listResult.isError).not.toBe(true);
  expect(structured(listResult)).toMatchObject({
    result: {
      items: [
        { address: "0x1000", value: "main" },
        { address: "0x2000", value: "helper" },
      ],
      total: 2,
      has_more: false,
    },
  });

  const decompileResult = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: "0x1000" },
  });
  expect(structured(decompileResult)).toMatchObject({
    result: "pseudo for 0x1000",
  });

  const xrefResult = await client.callTool({
    name: "xrefs",
    arguments: {},
  });
  expect(structured(xrefResult)).toMatchObject({
    result: ["0x1000"],
  });
});

it("advertises the complete currently available inventory with a session", async () => {
  const session = composeBinarySessionFromFactory(
    (_path) =>
      ({
        execute: () => Promise.resolve(ok(null)),
        close: () => Promise.resolve(),
      }) satisfies AnalysisClient,
  );
  const server = createServer(
    { execute: () => Promise.resolve(ok(null)) },
    session,
  );
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  expect(names).toContain("open_binary");
  expect(names).toContain("close_binary");
  expect(names).toContain("binary_session");
  expect(names).toContain("binary_overview");
  expect(names).toContain("batch_decompile");
  const status = structured(
    await client.callTool({
      name: "binary_session",
      arguments: { detail: "full" },
    }),
  );
  const available = new Set(
    z
      .object({
        result: z.object({
          tool_availability: z.array(
            z.object({ name: z.string(), available: z.boolean() }),
          ),
        }),
      })
      .parse(status)
      .result.tool_availability.filter((item) => item.available)
      .map(({ name }) => name),
  );
  expect(new Set(names)).toEqual(
    new Set(TOOL_CONTRACTS.map(({ name }) => name)),
  );
  expect(available).not.toContain("binary_overview");
  expect(available).not.toContain("batch_decompile");

  const contracts = new Map<string, (typeof TOOL_CONTRACTS)[number]>(
    TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
  );
  for (const tool of listed.tools) {
    const contract = contracts.get(tool.name);
    expect(contract, tool.name).toBeDefined();
    expect(tool.title, tool.name).toBe(contract?.title);
    expect(tool.description, tool.name).toBe(contract?.description);
    expect(tool.annotations, tool.name).toEqual(contract?.annotations);
    expect(tool.inputSchema, tool.name).toBeDefined();
    expect(tool.outputSchema, tool.name).toBeDefined();
  }
}, 10_000);

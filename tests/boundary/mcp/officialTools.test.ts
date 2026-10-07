import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { HopperRemoteError } from "../../../src/domain/hopperErrors.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";

interface Invocation {
  readonly name: string;
  readonly arguments_: Readonly<Record<string, JsonValue>>;
}

const resources: Array<{ close(): Promise<void> }> = [];

describe("read_bytes contract", () => {
  it("accepts lengths above the former arbitrary ceiling and rejects zero", () => {
    const contract = OFFICIAL_TOOL_CONTRACTS.find(
      ({ name }) => name === "read_bytes",
    );
    expect(contract).toBeDefined();
    expect(
      contract?.inputSchema.safeParse({ address: "0x1000", length: 4097 })
        .success,
    ).toBe(true);
    expect(
      contract?.inputSchema.safeParse({ address: "0x1000", length: 0 }).success,
    ).toBe(false);
    expect(
      contract?.outputSchema.shape.result.safeParse({
        address: "0x1000",
        requested_bytes: 4097,
        returned_bytes: 4097,
        bytes_hex: "ff".repeat(4097),
        complete: true,
      }).success,
    ).toBe(true);
  });
});

describe("list_strings contract", () => {
  it("describes optional provider string metadata inline", () => {
    const contract = OFFICIAL_TOOL_CONTRACTS.find(
      ({ name }) => name === "list_strings",
    );
    expect(
      contract?.outputSchema.shape.result.safeParse([
        {
          address: "0x1000",
          value: "coffee",
          string: {
            encoding: "UTF-8",
            termination: "present_or_not_required",
            byte_length: 6,
          },
        },
        { address: "0x1008", value: "beans" },
      ]).success,
    ).toBe(true);
  });
});

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort) => {
  const server = createServer(analysis);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

describe("official tool input contracts", () => {
  it("rejects misspelled top-level inputs before dispatch and keeps record keys open", async () => {
    const invocations: Invocation[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        invocations.push({ name, arguments_ });
        return Promise.resolve(ok(null));
      },
    });
    const { tools } = await client.listTools();
    const advertisedByName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const contract of OFFICIAL_TOOL_CONTRACTS) {
      expect(advertisedByName.get(contract.name)?.inputSchema).toHaveProperty(
        "additionalProperties",
        false,
      );
    }
    const advertised = tools.find(({ name }) => name === "address_name");
    const recordTool = tools.find(({ name }) => name === "set_addresses_names");
    if (advertised === undefined || recordTool === undefined)
      throw new Error("Official tools were not advertised");

    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateAddressName = ajv.compile(advertised.inputSchema);
    const validateRecordInput = ajv.compile(recordTool.inputSchema);
    const typoInput = { adress: "0x1234" };
    expect(advertised.inputSchema).toHaveProperty(
      "additionalProperties",
      false,
    );
    expect(validateAddressName(typoInput)).toBe(false);
    expect(
      OFFICIAL_TOOL_CONTRACTS.find(
        ({ name }) => name === "address_name",
      )?.inputSchema.safeParse(typoInput).success,
    ).toBe(false);
    expect(validateRecordInput({ names: { "0x1000": "entry" } })).toBe(true);

    const result = await client.callTool({
      name: "address_name",
      arguments: typoInput,
    });
    expect(result.isError).toBe(true);
    expect(invocations).toEqual([]);
  });
});

describe("official Hopper proxy tools", () => {
  it("returns stable safe MCP error content", async () => {
    const client = await connect({
      execute: () => Promise.resolve(err(new HopperRemoteError(-1, "denied"))),
    });
    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });

  it("binds list_procedures and projects its omitted Python document option", async () => {
    const invocations: Invocation[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        invocations.push({ name, arguments_ });
        return Promise.resolve(
          ok([
            { address: "0x1", value: "procedure" },
            { address: "0x2", value: "procedure" },
          ]),
        );
      },
    });

    const result = await client.callTool({
      name: "list_procedures",
      arguments: {},
    });

    expect(result.structuredContent).toMatchObject({
      result: [
        { address: "0x1", value: "procedure" },
        { address: "0x2", value: "procedure" },
      ],
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.name).toBe("list_procedures");
    expect(invocations[0]?.arguments_).toEqual({ document: null });
    expect(
      (await client.listTools()).tools.find(
        ({ name }) => name === "list_procedures",
      )?.inputSchema,
    ).not.toHaveProperty("properties.offset");
  });

  it("returns every search match inline in one provider call", async () => {
    const invocations: Invocation[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        invocations.push({ name, arguments_ });
        return Promise.resolve(
          ok([
            { address: "0x1", value: "coffee" },
            { address: "0x2", value: "coffee" },
          ]),
        );
      },
    });

    const result = await client.callTool({
      name: "search_strings",
      arguments: { pattern: "coffee" },
    });

    expect(result.structuredContent).toMatchObject({
      result: [
        { address: "0x1", value: "coffee" },
        { address: "0x2", value: "coffee" },
      ],
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.arguments_).toMatchObject({ pattern: "coffee" });
    expect(
      (await client.listTools()).tools.find(
        ({ name }) => name === "search_strings",
      )?.inputSchema,
    ).not.toHaveProperty("properties.offset");
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { HopperRemoteError } from "../../../src/domain/hopperErrors.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";

const VALID_INPUTS: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  address_name: {},
  inspect_native_instruction: { address: "0x1000" },
  resolve_native_call_targets: { address: "0x1000" },
  inspect_native_data_type: { type: "/Missing" },
  comment: {},
  current_address: {},
  current_procedure: {},
  current_document: {},
  goto_address: { address: "0x1000" },
  inline_comment: {},
  list_bookmarks: {},
  list_documents: {},
  list_names: {},
  list_procedures: {},
  list_segments: {},
  list_strings: {},
  next_address: {},
  prev_address: {},
  procedure_address: { procedure: "main" },
  procedure_assembly: { procedure: "main" },
  procedure_callees: { procedure: "main" },
  procedure_callers: { procedure: "main" },
  procedure_info: { procedure: "main" },
  read_function_instructions: { procedure: "main" },
  read_bytes: { address: "0x1000", length: 4 },
  address_to_file_offset: { address: "0x1000" },
  procedure_references: { procedure: "main" },
  procedure_pseudo_code: { procedure: "main" },
  resolve_containing_procedure: { address: "0x1000" },
  search_procedures: { pattern: "main" },
  search_strings: { pattern: "hello" },
  set_address_name: { address: "0x1000", name: "entry" },
  set_addresses_names: { names: { "0x1000": "entry" } },
  set_bookmark: { address: "0x1000" },
  set_comment: { address: "0x1000", comment: "entry point" },
  set_current_document: { document: "fixture" },
  set_inline_comment: { address: "0x1000", comment: "entry point" },
  unset_bookmark: { address: "0x1000" },
  xrefs: {},
};

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

const inventory: JsonValue = [];

const outputFor = (name: string): JsonValue => {
  if (name === "inspect_native_instruction")
    return {
      address: "0x1000",
      status: "decoded",
      procedure: "0x1000",
      architecture: "x86:LE:64:default",
      mode: "default",
      bytes: "c3",
      length: 1,
      mnemonic: "RET",
      raw_disassembly: "RET",
      operands: [],
      flow: {
        kind: "terminal",
        conditional: false,
        computed: false,
        direct_destinations: [],
      },
      references: [],
      limitations: ["Provider decoder observation"],
    };
  if (name === "resolve_native_call_targets")
    return {
      call_site: "0x1000",
      procedure: "0x1000",
      status: "not-call",
      mechanism: "unavailable",
      targets: [],
      limitations: [],
    };
  if (name === "inspect_native_data_type")
    return {
      status: "unavailable",
      reason: "Type absent",
      id: null,
      name: null,
      kind: "unavailable",
      source: "analysis-database",
      source_archive: null,
      address: null,
      size_bytes: null,
      alignment_bytes: null,
      packing_enabled: null,
      referenced_type: null,
      array_count: null,
      array_stride_bytes: null,
      fields: [],
      members: [],
      total_fields: 0,
      truncated: false,
      limitations: [],
    };
  if (["list_procedures", "list_names", "list_strings"].includes(name))
    return inventory;
  if (["address_name", "comment", "inline_comment"].includes(name)) return null;
  if (["procedure_callees", "procedure_callers", "xrefs"].includes(name))
    return [];
  if (["list_bookmarks", "list_documents", "list_segments"].includes(name))
    return [];
  if (
    [
      "set_address_name",
      "set_bookmark",
      "set_comment",
      "set_inline_comment",
      "unset_bookmark",
    ].includes(name)
  )
    return true;
  if (name === "set_addresses_names") return { "0x1000": true };
  if (["search_procedures", "search_strings"].includes(name)) return inventory;
  if (name === "procedure_info")
    return {
      name: "main",
      entrypoint: "0x1000",
      basicblock_count: 1,
      length: 4,
      signature: null,
      locals: [],
    };
  if (name === "resolve_containing_procedure")
    return {
      query_address: "0x1000",
      found: true,
      procedure: { address: "0x1000", name: "main" },
    };
  if (name === "read_function_instructions")
    return {
      procedure: { address: "0x1000", name: "main" },
      instructions: ["0x1000: ret"],
      limitations: ["Provider-specific instruction text."],
    };
  if (name === "read_bytes")
    return {
      address: "0x1000",
      requested_bytes: 4,
      returned_bytes: 4,
      bytes_hex: "c3c3c3c3",
      complete: true,
    };
  if (name === "address_to_file_offset")
    return { address: "0x1000", file_offset: 0 };
  if (name === "procedure_references")
    return {
      procedure: { address: "0x1000", name: "main" },
      direction: "outgoing",
      references: [],
    };
  return name.includes("address") ? "0x1000" : "fixture";
};

describe("official Hopper proxy tools", () => {
  it("executes every handler and projects omitted Python optionals to null", async () => {
    const invocations: Invocation[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        invocations.push({ name, arguments_ });
        return Promise.resolve(ok(outputFor(name)));
      },
    });

    for (const contract of OFFICIAL_TOOL_CONTRACTS) {
      const result = await client.callTool({
        name: contract.name,
        arguments: VALID_INPUTS[contract.name],
      });
      expect(result.isError).not.toBe(true);
    }

    expect(invocations.map(({ name }) => name)).toEqual(
      OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
    );
    expect(
      invocations.find(({ name }) => name === "address_name")?.arguments_,
    ).toEqual({
      document: null,
      address: null,
    });
    expect(
      invocations.find(({ name }) => name === "search_procedures")?.arguments_,
    ).toEqual({
      pattern: "main",
      mode: "literal",
      case_sensitive: false,
      document: null,
    });
    expect(
      invocations.find(({ name }) => name === "search_strings")?.arguments_,
    ).toEqual({
      pattern: "hello",
      mode: "literal",
      case_sensitive: false,
      document: null,
    });
  });

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

  it("returns every procedure inline without caller-authored page calls", async () => {
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

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../src/application/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { HopperRemoteError } from "../src/domain/errors.js";
import { err } from "../src/domain/result.js";
import { observed as ok } from "./fixtures/analysisExecution.js";
import type { JsonValue } from "../src/domain/jsonValue.js";
import { createServer } from "../src/server/createServer.js";

const VALID_INPUTS: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  address_name: {},
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

const page: JsonValue = {
  items: [],
  offset: 0,
  limit: 100,
  total: 0,
  next_offset: null,
  has_more: false,
};

const outputFor = (name: string): JsonValue => {
  if (["list_procedures", "list_names", "list_strings"].includes(name))
    return page;
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
  if (["search_procedures", "search_strings"].includes(name)) return page;
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
      instructions: {
        items: ["0x1000: ret"],
        total: 1,
        returned: 1,
        truncated: false,
        next_offset: null,
      },
      instructions_scanned: 1,
      instruction_scan_truncated: false,
      limitations: ["Provider-specific instruction text."],
    };
  if (name === "procedure_references")
    return {
      procedure: { address: "0x1000", name: "main" },
      direction: "outgoing",
      references: {
        items: [],
        total: 0,
        returned: 0,
        truncated: false,
        next_offset: null,
      },
      instructions_scanned: 1,
      instruction_scan_truncated: false,
    };
  return name.includes("address") ? "0x1000" : "fixture";
};

describe("official Hopper proxy tools", () => {
  it("lists every official contract", async () => {
    const client = await connect({
      execute: () => Promise.resolve(ok(null)),
    });
    const listed = await client.listTools();
    const officialNames = new Set<string>(
      OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
    );
    expect(
      listed.tools
        .map(({ name }) => name)
        .filter((name) => officialNames.has(name))
        .sort(),
    ).toEqual(OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name).sort());
  });

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
      expect(result.content).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "resource_link" }),
        ]),
      );
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
      offset: 0,
      limit: 100,
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
});

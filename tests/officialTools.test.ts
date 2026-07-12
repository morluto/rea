import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { HopperToolPort } from "../src/application/HopperToolPort.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { HopperRemoteError } from "../src/domain/errors.js";
import { err, ok } from "../src/domain/result.js";
import type { JsonValue } from "../src/hopper/protocol.js";
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
  procedure_pseudo_code: { procedure: "main" },
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

const connect = async (hopper: HopperToolPort) => {
  const server = createServer(hopper);
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

describe("official Hopper proxy tools", () => {
  it("lists exactly the 31 official contracts", async () => {
    const client = await connect({
      callTool: () => Promise.resolve(ok(null)),
    });
    const listed = await client.listTools();
    const officialNames = new Set(
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
      callTool: (name, arguments_) => {
        invocations.push({ name, arguments_ });
        return Promise.resolve(
          ok(
            ["list_procedures", "list_names", "list_strings"].includes(name)
              ? page
              : { name, arguments: arguments_ },
          ),
        );
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
      case_sensitive: false,
      document: null,
    });
  });

  it("returns stable safe MCP error content", async () => {
    const client = await connect({
      callTool: () => Promise.resolve(err(new HopperRemoteError(-1, "denied"))),
    });
    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "HopperRemoteError: Hopper request failed (-1): denied",
      },
    ]);
  });
});

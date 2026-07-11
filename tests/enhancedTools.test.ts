import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { HopperToolPort } from "../src/application/HopperToolPort.js";
import { ENHANCED_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { ok } from "../src/domain/result.js";
import { jsonValueSchema, type JsonValue } from "../src/hopper/protocol.js";
import { createServer } from "../src/server/createServer.js";

const PROCEDURES = {
  "0x1": "_TtC7Fixture5Class",
  "0x2": "_TtV7Fixture6Struct",
  "0x3": "_TtP7Fixture8Protocol",
  "0x4": "_TtO7Fixture4Enum",
  "0x5": "_TtE7Fixture9Extension",
  "0x6": "prefix_TtOther",
};

const fixturePort = (): HopperToolPort => ({
  callTool: (name, arguments_) => {
    switch (name) {
      case "list_procedures":
        return Promise.resolve(ok(PROCEDURES));
      case "list_names":
        return Promise.resolve(
          ok([
            { address: "0x10", name: "_OBJC_CLASS_$_Fixture" },
            { address: "0x11", name: "_OBJC_CLASS_$_Fixture" },
            { address: "0x12", name: "_OBJC_PROTOCOL_$_FixtureDelegate" },
          ]),
        );
      case "procedure_pseudo_code": {
        const procedure = arguments_.procedure;
        return Promise.resolve(
          ok(typeof procedure === "string" ? `pseudo:${procedure}` : "invalid"),
        );
      }
      case "procedure_callees": {
        const procedure = arguments_.procedure;
        return Promise.resolve(
          ok(
            procedure === "0x1"
              ? ["0x2", "0x3"]
              : procedure === "0x2"
                ? ["0x1"]
                : [],
          ),
        );
      }
      case "procedure_callers":
        return Promise.resolve(ok(["0x9"]));
      case "address_name":
        return Promise.resolve(
          ok({ address: "0x1", name: arguments_.address ?? "" }),
        );
      case "xrefs":
        return Promise.resolve(ok(["0x20", "0x21"]));
      case "list_segments":
        return Promise.resolve(
          ok([{ name: "__TEXT", start: "0x1000", end: "0x2000" }]),
        );
      case "list_documents":
        return Promise.resolve(ok(["fixture"]));
      case "list_strings":
        return Promise.resolve(ok([{ address: "0x30", value: "hello" }]));
      default:
        return Promise.resolve(ok(null));
    }
  },
});

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (hopper: HopperToolPort = fixturePort()) => {
  const server = createServer(hopper);
  const client = new Client({ name: "enhanced-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const jsonResult = (result: CallToolResult): JsonValue => {
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool result omitted text content");
  const decoded: unknown = JSON.parse(text.text);
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Tool result was not JSON");
  return parsed.data;
};

describe("enhanced MCP tools", () => {
  it("lists the complete 31 plus 8 surface", async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(39);
    expect(
      listed.tools
        .map(({ name }) => name)
        .filter((name) =>
          ENHANCED_TOOL_CONTRACTS.some((tool) => tool.name === name),
        )
        .sort(),
    ).toEqual(ENHANCED_TOOL_CONTRACTS.map(({ name }) => name).sort());
  });

  it("executes all eight tools through production registration", async () => {
    const client = await connect();
    const calls = [
      ["swift_classes", { pattern: "Fixture" }],
      ["get_objc_classes", { pattern: "Fixture" }],
      ["get_objc_protocols", {}],
      ["batch_decompile", { addresses: ["0x1", "0x2"] }],
      ["get_call_graph", { address: "0x1", direction: "forward", depth: 2 }],
      ["analyze_swift_types", {}],
      ["find_xrefs_to_name", { name: "entry" }],
      ["binary_overview", {}],
    ] as const;
    const results = [];
    for (const [name, arguments_] of calls) {
      results.push(
        jsonResult(await client.callTool({ name, arguments: arguments_ })),
      );
    }
    expect(results[0]).toMatchObject({ count: 1 });
    // Legacy behavior treats any `_OBJC_` label, including protocol labels, as a class.
    expect(results[1]).toMatchObject({ count: 2 });
    expect(results[2]).toMatchObject({ count: 1 });
    expect(results[3]).toEqual({ "0x1": "pseudo:0x1", "0x2": "pseudo:0x2" });
    expect(results[4]).toEqual({
      "0": [{ address: "0x1", calls: ["0x2", "0x3"] }],
      "1": [
        { address: "0x2", calls: ["0x1"] },
        { address: "0x3", calls: [] },
      ],
    });
    expect(results[5]).toMatchObject({ total: 6 });
    expect(results[6]).toEqual({ xrefs: ["0x20", "0x21"] });
    expect(results[7]).toMatchObject({
      document: "fixture",
      segment_count: 1,
      procedure_count: 6,
      string_count: 1,
    });
  });

  it("bounds batch concurrency at the parsed maximum of 20", async () => {
    let active = 0;
    let maximum = 0;
    const hopper: HopperToolPort = {
      callTool: async (name) => {
        if (name !== "procedure_pseudo_code") return ok(null);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return ok("pseudo");
      },
    };
    const client = await connect(hopper);
    const result = await client.callTool({
      name: "batch_decompile",
      arguments: {
        addresses: Array.from(
          { length: 20 },
          (_, index) => `0x${String(index)}`,
        ),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(maximum).toBe(20);
  });

  it("returns a typed tool error for malformed Hopper boundary values", async () => {
    const client = await connect({
      callTool: () => Promise.resolve(ok(["not", "a", "procedure", "map"])),
    });
    const result = await client.callTool({
      name: "swift_classes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain(
      "HopperProtocolError",
    );
  });
});

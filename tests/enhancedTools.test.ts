import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../src/application/EnhancedTools.js";
import { ENHANCED_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { AnalysisOutputError } from "../src/domain/errors.js";
import { jsonValueSchema, type JsonValue } from "../src/domain/jsonValue.js";
import { err } from "../src/domain/result.js";
import { createServer } from "../src/server/createServer.js";
import { observed as ok } from "./fixtures/analysisExecution.js";

const PROCEDURES = {
  "0x1": "_TtC7Fixture5Class",
  "0x2": "_TtV7Fixture6Struct",
  "0x3": "_TtP7Fixture8Protocol",
  "0x4": "_TtO7Fixture4Enum",
  "0x5": "_TtE7Fixture9Extension",
  "0x6": "prefix_TtOther",
};

const page = (values: Readonly<Record<string, string>>) => ({
  items: Object.entries(values).map(([address, value]) => ({ address, value })),
  offset: 0,
  limit: 100,
  total: Object.keys(values).length,
  next_offset: null,
  has_more: false,
});

const fixturePort = (): AnalysisOperationPort => ({
  execute: (name, arguments_) => {
    switch (name) {
      case "list_procedures":
        return Promise.resolve(ok(page(PROCEDURES)));
      case "list_names":
        return Promise.resolve(
          ok(
            page({
              "0x10": "_OBJC_CLASS_$_Fixture",
              "0x11": "_OBJC_CLASS_$_Fixture",
              "0x12": "_OBJC_PROTOCOL_$_FixtureDelegate",
              "0x13": "entry",
            }),
          ),
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
        return Promise.resolve(ok(arguments_.address ?? null));
      case "xrefs":
        return Promise.resolve(ok(["0x20", "0x21"]));
      case "resolve_containing_procedure":
        return Promise.resolve(
          ok({
            query_address:
              typeof arguments_.address === "string"
                ? arguments_.address
                : "0x0",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          }),
        );
      case "list_segments":
        return Promise.resolve(
          ok([{ name: "__TEXT", start: "0x1000", end: "0x2000" }]),
        );
      case "list_documents":
        return Promise.resolve(ok(["fixture"]));
      case "list_strings":
        return Promise.resolve(ok(page({ "0x30": "hello" })));
      case "analyze_function":
        return Promise.resolve(
          ok({
            procedure: {
              address: "0x1",
              name: "entry",
              signature: null,
              locals: [],
            },
            pseudocode: {
              text: "return 0;",
              total_chars: 9,
              returned_chars: 9,
              truncated: false,
              next_offset: null,
            },
            assembly: {
              items: [],
              total: 0,
              returned: 0,
              truncated: false,
              next_offset: null,
            },
            comments: emptyBounded(),
            callers: emptyBounded(),
            callees: emptyBounded(),
            incoming_references: emptyBounded(),
            outgoing_references: emptyBounded(),
            referenced_strings: emptyBounded(),
            referenced_names: emptyBounded(),
            basic_blocks: emptyBounded(),
            instruction_scan: { scanned: 0, truncated: false },
          }),
        );
      default:
        return Promise.resolve(ok(null));
    }
  },
});

const emptyBounded = () => ({
  items: [],
  total: 0,
  returned: 0,
  truncated: false,
  next_offset: null,
});

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort = fixturePort()) => {
  const server = createServer(analysis);
  const client = new Client({ name: "enhanced-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const jsonResult = (result: CallToolResult): JsonValue => {
  if (result.structuredContent === undefined)
    throw new Error("Tool result omitted structured content");
  const structured = jsonValueSchema.safeParse(result.structuredContent);
  if (!structured.success)
    throw new Error("Tool structured result was not JSON");
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "normalized_result" in structured.data
  ) {
    return structured.data.normalized_result ?? null;
  }
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool result omitted text content");
  const decoded: unknown = JSON.parse(text.text);
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Tool result was not JSON");
  return parsed.data;
};

describe("enhanced MCP tools", () => {
  it("lists the complete 33 plus 10 surface", async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(50);
    expect(
      listed.tools
        .map(({ name }) => name)
        .filter((name) =>
          ENHANCED_TOOL_CONTRACTS.some((tool) => tool.name === name),
        )
        .sort(),
    ).toEqual(ENHANCED_TOOL_CONTRACTS.map(({ name }) => name).sort());
  });

  it("executes all ten tools through production registration", async () => {
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
      ["analyze_function", { procedure: "0x1" }],
      ["trace_feature", { query: "hello", max_operations: 10 }],
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
    expect(results[3]).toEqual({
      items: [
        { address: "0x1", status: "ok", pseudocode: "pseudo:0x1" },
        { address: "0x2", status: "ok", pseudocode: "pseudo:0x2" },
      ],
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(results[4]).toEqual({
      "0": [{ address: "0x1", status: "ok", calls: ["0x2", "0x3"] }],
      "1": [
        { address: "0x2", status: "ok", calls: ["0x1"] },
        { address: "0x3", status: "ok", calls: [] },
      ],
    });
    expect(results[5]).toMatchObject({ total: 6 });
    expect(results[6]).toEqual({
      status: "resolved",
      name: "entry",
      address: "0x13",
      xrefs: ["0x20", "0x21"],
    });
    expect(results[7]).toMatchObject({
      document: "fixture",
      segment_count: 1,
      procedure_count: 6,
      string_count: 1,
    });
    expect(results[8]).toMatchObject({
      procedure: { address: "0x1", name: "entry" },
      pseudocode: { text: "return 0;" },
    });
    expect(results[9]).toMatchObject({
      query: "hello",
      search_mode: "literal",
      truncated: false,
      references: [
        { target_address: "0x30", source_address: "0x20" },
        { target_address: "0x30", source_address: "0x21" },
      ],
    });
  });

  it("bounds batch concurrency at the parsed maximum of 20", async () => {
    let active = 0;
    let maximum = 0;
    const analysis: AnalysisOperationPort = {
      execute: async (name) => {
        if (name !== "procedure_pseudo_code") return ok(null);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return ok("pseudo");
      },
    };
    const client = await connect(analysis);
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

  it("returns ordered typed batch failures and zero counts for empty input", async () => {
    const tools = new EnhancedTools({
      execute: (_name, arguments_) =>
        arguments_.procedure === "0x2"
          ? Promise.resolve(err(new AnalysisOutputError("decompile", "failed")))
          : Promise.resolve(ok("pseudo")),
    });

    const result = await tools.execute("batch_decompile", {
      addresses: ["0x1", "0x2"],
    });
    const empty = await tools.execute("batch_decompile", { addresses: [] });

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          { address: "0x1", status: "ok", pseudocode: "pseudo" },
          {
            address: "0x2",
            status: "error",
            error: {
              category: "execution_failure",
              message:
                "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
            },
          },
        ],
        total: 2,
        succeeded: 1,
        failed: 1,
      },
    });
    expect(empty).toEqual({
      ok: true,
      value: { items: [], total: 0, succeeded: 0, failed: 0 },
    });
  });

  it("returns typed graph failures and stable unresolved-name results", async () => {
    const tools = new EnhancedTools({
      execute: (name) =>
        name === "procedure_callees"
          ? Promise.resolve(err(new AnalysisOutputError(name, "failed")))
          : Promise.resolve(ok(page({}))),
    });

    const graph = await tools.execute("get_call_graph", {
      address: "0x1",
      direction: "forward",
      depth: 1,
    });
    const unresolved = await tools.execute("find_xrefs_to_name", {
      name: "missing",
    });

    expect(graph).toMatchObject({
      ok: true,
      value: {
        "0": [
          {
            address: "0x1",
            status: "error",
            error: {
              category: "execution_failure",
              message:
                "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
            },
          },
        ],
      },
    });
    expect(unresolved).toEqual({
      ok: true,
      value: {
        status: "unresolved",
        name: "missing",
        reason: "name_not_found",
      },
    });
  });

  it("follows procedure pagination for whole-binary workflows", async () => {
    const offsets: number[] = [];
    const client = await connect({
      execute: (_name, arguments_) => {
        const offset = arguments_.offset;
        offsets.push(typeof offset === "number" ? offset : 0);
        return Promise.resolve(
          ok({
            items: [
              {
                address: offset === 500 ? "0x2" : "0x1",
                value: offset === 500 ? "_TtC4Last" : "_TtC5First",
              },
            ],
            offset: typeof offset === "number" ? offset : 0,
            limit: 500,
            total: 2,
            next_offset: offset === 500 ? null : 500,
            has_more: offset !== 500,
          }),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "swift_classes", arguments: {} }),
    );
    expect(offsets).toEqual([0, 500]);
    expect(result).toMatchObject({ count: 2 });
  });

  it("does not start another page after cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const analysis: AnalysisOperationPort = {
      execute: () => {
        calls += 1;
        controller.abort();
        return Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "_TtC5First" }],
            offset: 0,
            limit: 500,
            total: 2,
            next_offset: 500,
            has_more: true,
          }),
        );
      },
    };

    const result = await new EnhancedTools(analysis).execute(
      "swift_classes",
      {},
      controller.signal,
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });

  it("follows name pagination for exhaustive Objective-C discovery", async () => {
    const offsets: number[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        expect(name).toBe("list_names");
        const offset =
          typeof arguments_.offset === "number" ? arguments_.offset : 0;
        offsets.push(offset);
        return Promise.resolve(
          ok({
            items: [
              {
                address: offset === 500 ? "0x2" : "0x1",
                value:
                  offset === 500 ? "_OBJC_CLASS_$_Last" : "_OBJC_CLASS_$_First",
              },
            ],
            offset,
            limit: 500,
            total: 2,
            next_offset: offset === 500 ? null : 500,
            has_more: offset !== 500,
          }),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "get_objc_classes", arguments: {} }),
    );
    expect(offsets).toEqual([0, 500]);
    expect(result).toMatchObject({ count: 2 });
  });

  it("honors overview detail and limit while reporting exhaustive totals", async () => {
    const procedureOffsets: number[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        switch (name) {
          case "list_segments":
            return Promise.resolve(
              ok([
                { name: "__TEXT", start: "0x1000", end: "0x1800" },
                { name: "__DATA", start: "0x1800", end: "0x2000" },
              ]),
            );
          case "list_documents":
            return Promise.resolve(ok(["fixture"]));
          case "list_strings":
            return Promise.resolve(
              ok({
                items: [{ address: "0x30", value: "first page only" }],
                offset: 0,
                limit: 100,
                total: 700,
                next_offset: 100,
                has_more: true,
              }),
            );
          case "list_procedures": {
            const offset =
              typeof arguments_.offset === "number" ? arguments_.offset : 0;
            procedureOffsets.push(offset);
            return Promise.resolve(
              ok({
                items: [
                  {
                    address: offset === 500 ? "0x2" : "0x1",
                    value: offset === 500 ? "last" : "first",
                  },
                ],
                offset,
                limit: 500,
                total: 2,
                next_offset: offset === 500 ? null : 500,
                has_more: offset !== 500,
              }),
            );
          }
          default:
            return Promise.resolve(ok(null));
        }
      },
    });
    const result = jsonResult(
      await client.callTool({
        name: "binary_overview",
        arguments: { detail: "detailed", limit: 1 },
      }),
    );
    expect(procedureOffsets).toEqual([0, 500]);
    expect(result).toEqual({
      document: "fixture",
      detail: "detailed",
      segments: [
        { name: "__TEXT", start: "0x1000", end: "0x1800", length: 2048 },
      ],
      segment_count: 2,
      procedure_count: 2,
      string_count: 700,
    });
  });

  it("rejects non-advancing pagination metadata", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "_TtC5First" }],
            offset: 0,
            limit: 500,
            total: 2,
            next_offset: 0,
            has_more: true,
          }),
        ),
    });
    const result = await client.callTool({
      name: "swift_classes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
    );
  });

  it("stops trace_feature at its explicit operation budget", async () => {
    let operations = 0;
    const client = await connect({
      execute: () => {
        operations += 1;
        return Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "needle" }],
            offset: 0,
            limit: 500,
            total: 2,
            next_offset: 1,
            has_more: true,
          }),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({
        name: "trace_feature",
        arguments: { query: "needle", max_operations: 1 },
      }),
    );
    expect(operations).toBe(1);
    expect(result).toMatchObject({
      operations_used: 1,
      operation_budget: 1,
      truncated: true,
    });
    expect(JSON.stringify(result)).toContain("operation budget");
  });

  it("returns a typed tool error for malformed Hopper boundary values", async () => {
    const client = await connect({
      execute: () => Promise.resolve(ok(["not", "a", "procedure", "map"])),
    });
    const result = await client.callTool({
      name: "swift_classes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
    );
  });

  it("rejects incomplete function dossiers at the application boundary", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            procedure: { address: "0x1", name: "entry" },
            pseudocode: { text: "plausible but incomplete" },
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
    );
  });

  it("rejects deceptive function dossier collection metadata", async () => {
    const malformedPort = fixturePort();
    const client = await connect({
      execute: async (name, arguments_, options) => {
        const result = await malformedPort.execute(name, arguments_, options);
        if (!result.ok || name !== "analyze_function") return result;
        const dossier = result.value.result;
        if (
          typeof dossier !== "object" ||
          dossier === null ||
          Array.isArray(dossier)
        )
          return result;
        return ok({
          ...dossier,
          comments: {
            items: [],
            total: 0,
            returned: 1,
            truncated: false,
            next_offset: null,
          },
        });
      },
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
    );
  });

  it("accepts a final dossier page whose total exceeds returned", async () => {
    const malformedPort = fixturePort();
    const client = await connect({
      execute: async (name, arguments_, options) => {
        const result = await malformedPort.execute(name, arguments_, options);
        if (!result.ok || name !== "analyze_function") return result;
        const dossier = result.value.result;
        if (
          typeof dossier !== "object" ||
          dossier === null ||
          Array.isArray(dossier)
        )
          return result;
        return ok({
          ...dossier,
          callers: {
            items: [],
            total: 1,
            returned: 0,
            truncated: false,
            next_offset: null,
          },
        });
      },
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).not.toBe(true);
  });
});

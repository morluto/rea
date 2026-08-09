import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

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
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "evidence_id" in structured.data &&
    "result" in structured.data
  )
    return structured.data.result ?? null;
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool result omitted text content");
  const decoded: unknown = JSON.parse(text.text);
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Tool result was not JSON");
  return parsed.data;
};

describe("enhanced MCP tools", () => {
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

  it("lets the SDK reject misspelled and out-of-range inputs", async () => {
    const client = await connect();
    const valid = await client.callTool({
      name: "trace_feature",
      arguments: { query: "needle", max_operations: 1 },
    });
    expect(valid.isError).not.toBe(true);
    const misspelled = await client.callTool({
      name: "trace_feature",
      arguments: { query: "needle", max_operatons: 1 },
    });
    expect(misspelled.isError).toBe(true);
    expect(misspelled.structuredContent).toBeUndefined();
    const nestedMisspelled = await client.callTool({
      name: "analyze_function",
      arguments: {
        procedure: "0x1",
        collection_offset: { commentz: 1 },
      },
    });
    expect(nestedMisspelled.isError).toBe(true);
    expect(nestedMisspelled.structuredContent).toBeUndefined();
    const bounded = await client.callTool({
      name: "trace_feature",
      arguments: { query: "needle", max_operations: 101 },
    });
    expect(bounded.isError).toBe(true);
    expect(bounded.structuredContent).toBeUndefined();
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
      JSON.stringify(result.structuredContent),
    );
  });
});

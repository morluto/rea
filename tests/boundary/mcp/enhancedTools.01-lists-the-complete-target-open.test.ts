import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { PROCEDURES, inventory, jsonResult } from "./enhancedToolsHarness.js";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../../../src/contracts/managed/managedWorkflowToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../../../src/contracts/enhancedToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import {} from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { err } from "../../../src/domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";

const targetObservation = (value: unknown) =>
  resultOk(
    createAnalysisExecution(
      value,
      {
        id: "fixture",
        name: "Fixture analysis provider",
        version: "1",
      },
      {
        subject: {
          path: "/fixture.app",
          sha256: "a".repeat(64),
          format: "mach-o",
          architecture: "arm64",
        },
      },
    ),
  );

const fixturePort = (): AnalysisOperationPort => ({
  // oxlint-disable-next-line complexity -- this fixture exhaustively serves the registered MCP surface.
  execute: (name, arguments_) => {
    switch (name) {
      case "inspect_native_dispatch_metadata":
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              "fixture",
              name,
              "No byte reader or exact native seed in this symbol-only fixture",
            ),
          ),
        );
      case "procedure_address": {
        const procedure = inventory(PROCEDURES).find(
          (item) =>
            item.address === arguments_.procedure ||
            item.value === arguments_.procedure,
        );
        return Promise.resolve(
          procedure === undefined
            ? err(
                new AnalysisCapabilityUnavailableError(
                  "fixture",
                  name,
                  "No matching procedure in this symbol-only fixture",
                ),
              )
            : ok(procedure.address),
        );
      }
      case "list_procedures":
        return Promise.resolve(ok(inventory(PROCEDURES)));
      case "list_names":
        return Promise.resolve(
          targetObservation(
            inventory({
              "0x10": "_OBJC_CLASS_$_Fixture",
              "0x11": "_OBJC_CLASS_$_Fixture",
              "0x12": "_OBJC_PROTOCOL_$_FixtureDelegate",
              "0x13": "entry",
            }),
          ),
        );
      case "decode_interface_builder":
        return Promise.resolve(
          targetObservation({
            target_sha256: "a".repeat(64),
            documents: [],
            graph: {
              target_sha256: "a".repeat(64),
              provider: {
                id: "rea-artifact-graph",
                version: "1",
                tool_version: "fixture",
              },
              nodes: [],
              edges: [],
              coverage: [],
              truncated: false,
            },
            limitations: [],
          }),
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
      case "current_document":
        return Promise.resolve(ok("fixture"));
      case "list_documents":
        return Promise.resolve(ok(["fixture"]));
      case "list_strings":
        return Promise.resolve(ok(inventory({ "0x30": "hello" })));
      case "search_strings":
        return Promise.resolve(ok(inventory({ "0x30": "hello" })));
      case "search_procedures":
        return Promise.resolve(ok(inventory({})));
      case "analyze_function":
        return Promise.resolve(
          targetObservation({
            procedure: {
              address: "0x1",
              name: "entry",
              signature: null,
              locals: [],
            },
            pseudocode: "return 0;",
            assembly: [],
            comments: [],
            callers: [],
            callees: [],
            incoming_references: [],
            outgoing_references: [],
            referenced_strings: [],
            referenced_names: [],
            basic_blocks: [],
          }),
        );
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

const connect = async (analysis: AnalysisOperationPort = fixturePort()) => {
  const server = createServer({ kind: "fixed", analysis });
  const client = new Client({ name: "enhanced-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

// oxlint-disable-next-line max-lines-per-function -- keep the complete production registration checks together.
describe("enhanced MCP tools", () => {
  it("lists the complete target-open analysis surface", async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(
      TOOL_CONTRACTS.length -
        SESSION_TOOL_CONTRACTS.length -
        MANAGED_WORKFLOW_TOOL_CONTRACTS.length,
    );
    expect(
      listed.tools
        .map(({ name }) => name)
        .filter((name) =>
          ENHANCED_TOOL_CONTRACTS.some((tool) => tool.name === name),
        )
        .sort(),
    ).toEqual(ENHANCED_TOOL_CONTRACTS.map(({ name }) => name).sort());
    expect(listed.tools.map(({ name }) => name)).not.toContain("open_binary");
  });

  // oxlint-disable-next-line max-lines-per-function -- one exhaustive registration test guards the public tool catalog.
  it("executes all enhanced tools through production registration", async () => {
    const client = await connect();
    const calls = [
      ["get_objc_classes", { pattern: "Fixture" }],
      ["get_objc_protocols", {}],
      ["batch_decompile", { addresses: ["0x1", "0x2"] }],
      ["get_call_graph", { address: "0x1", direction: "forward" }],
      ["analyze_swift_types", { category: "classes", pattern: "Fixture" }],
      ["find_xrefs_to_name", { name: "entry" }],
      ["binary_overview", {}],
      ["analyze_function", { procedure: "0x1" }],
      ["inspect_native_api", { procedure: "0x1" }],
      ["trace_feature", { query: "hello" }],
      ["trace_call_path", { start: "0x1", goal: "0x2" }],
      ["trace_native_ui_action", { action: "missing-selector" }],
      ["inspect_native_dispatch_metadata", { max_records: 100 }],
      ["trace_native_values", { procedure: "0x1" }],
    ] as const;
    const results = await Promise.all(
      calls.map(async ([name, arguments_]) =>
        jsonResult(await client.callTool({ name, arguments: arguments_ })),
      ),
    );
    expect(results[0]).toMatchObject({
      count: 1,
      classes: [{ address: "0x10", name: "_OBJC_CLASS_$_Fixture" }],
    });
    expect(results[1]).toMatchObject({
      count: 1,
      protocols: [
        { address: "0x12", name: "_OBJC_PROTOCOL_$_FixtureDelegate" },
      ],
    });
    expect(results[2]).toEqual({
      items: [
        {
          address: "0x1",
          procedure: { status: "resolved", address: "0x1", name: "0x1" },
          status: "ok",
          pseudocode: "pseudo:0x1",
        },
        {
          address: "0x2",
          procedure: { status: "resolved", address: "0x2", name: "0x2" },
          status: "ok",
          pseudocode: "pseudo:0x2",
        },
      ],
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(results[3]).toEqual({
      "0": [{ address: "0x1", status: "ok", calls: ["0x2", "0x3"] }],
      "1": [
        { address: "0x2", status: "ok", calls: ["0x1"] },
        { address: "0x3", status: "ok", calls: [] },
      ],
    });
    expect(results[4]).toMatchObject({
      total: 1,
      categories: {
        classes: {
          count: 1,
          items: [{ address: "0x1", name: "_TtC7Fixture5Class" }],
        },
      },
    });
    expect(results[5]).toEqual({
      status: "resolved",
      name: "entry",
      address: "0x13",
      xrefs: ["0x20", "0x21"],
    });
    expect(results[6]).toMatchObject({
      document: "fixture",
      segment_count: 1,
      procedure_count: 6,
      string_count: 1,
    });
    expect(results[7]).toMatchObject({
      procedure: { address: "0x1", name: "entry" },
      pseudocode: "return 0;",
    });
    expect(results[8]).toMatchObject({
      procedure: { address: "0x1", name: "entry" },
      boundary: { available: false },
      unsupported_branches: [
        "structured-boundary-types",
        "jump-table-data-mapping",
      ],
      residual_unknowns: expect.arrayContaining([
        expect.stringContaining("boundary types"),
      ]),
      substeps: [
        { operation: "analyze_function", status: "completed" },
        { operation: "project_native_api_boundary", status: "unsupported" },
        { operation: "preserve_residual_unknowns", status: "completed" },
      ],
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
    expect(results[10]).toMatchObject({
      start: "0x1",
      goal: "0x2",
      direction: "forward",
      goal_status: "reached",
      traversal_path: ["0x1", "0x2"],
      nodes: [
        { address: "0x1", depth: 0 },
        { address: "0x2", depth: 1 },
      ],
      truncated: false,
    });
    expect(results[11]).toMatchObject({
      start: "missing-selector",
      reason: "ui_action_or_object_not_found",
    });
    expect(results[12]).toMatchObject({
      target_sha256: "a".repeat(64),
      provider: {
        id: "fixture",
        name: "Fixture analysis provider",
        version: "1",
      },
      result: {
        coverage: expect.arrayContaining([
          expect.objectContaining({ facet: "objc_dispatch_implementations" }),
        ]),
      },
    });
    expect(results[13]).toMatchObject({
      target_sha256: "a".repeat(64),
      decompilations: 1,
      unknowns: [
        expect.objectContaining({
          reason: "Provider has no native def-use model",
        }),
      ],
    });
  });
});

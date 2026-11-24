import { afterEach, describe, expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/ports/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";

import {
  closeEnhancedToolResources,
  connect,
  inventory,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
  it("returns stable unresolved-name results", async () => {
    const tools = new EnhancedTools({
      execute: (operation) =>
        Promise.resolve(
          operation === "list_names"
            ? ok(inventory({}))
            : err(
                new AnalysisInputError(
                  operation,
                  { conformsToInputContract: true },
                  [{ path: ["procedure"], reason: "invalid_value" }],
                ),
              ),
        ),
    });

    const unresolved = await tools.executeValidated({
      name: "find_xrefs_to_name",
      input: { name: "missing" },
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

  it("uses every procedure in one complete inventory", async () => {
    const client = await connect({
      execute: () => {
        return Promise.resolve(
          ok([
            { address: "0x1", value: "_TtC5First" },
            { address: "0x2", value: "_TtC4Last" },
          ]),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "analyze_swift_types", arguments: {} }),
    );
    expect(result).toMatchObject({
      total: 2,
      categories: { classes: { count: 2 } },
    });
  });

  it("returns cancellation when a complete inventory call is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const analysis: AnalysisOperationPort = {
      execute: () => {
        calls += 1;
        controller.abort();
        return Promise.resolve(ok([{ address: "0x1", value: "_TtC5First" }]));
      },
    };

    const result = await new EnhancedTools(analysis).executeValidated(
      { name: "analyze_swift_types", input: {} },
      controller.signal,
    );

    expect(calls).toBe(1);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});

it("exact-name xrefs preserves ambiguity independently of inventory order and accepts repeated rows", async () => {
  let rows = [
    { address: "0x20", value: "entry" },
    { address: "0x10", value: "entry" },
  ];
  const queried: unknown[] = [];
  const client = await connect({
    execute: async (operation, parameters) => {
      if (operation === "list_names") return ok(rows);
      if (operation === "xrefs") {
        queried.push(parameters.address);
        return ok(["0x90"]);
      }
      throw new Error(`Unexpected operation ${operation}`);
    },
  });
  for (const reversed of [false, true]) {
    if (reversed) rows.reverse();
    const rejected = await client.callTool({
      name: "find_xrefs_to_name",
      arguments: { name: "entry" },
    });
    expect(parseMcpToolError(rejected).error).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: expect.stringContaining("Select an exact address"),
      },
      details: {
        issues: [
          expect.objectContaining({
            path: ["name"],
            message: expect.stringContaining("ambiguous at 0x10, 0x20"),
          }),
        ],
      },
    });
    expect(parseMcpToolError(rejected).error.recovery).toBeUndefined();
  }
  expect(queried).toEqual([]);
  rows = [
    { address: "0x10", value: "entry" },
    { address: "0x10", value: "entry" },
  ];
  expect(
    jsonResult(
      await client.callTool({
        name: "find_xrefs_to_name",
        arguments: { name: "entry" },
      }),
    ),
  ).toMatchObject({ status: "resolved", address: "0x10", xrefs: ["0x90"] });
  expect(queried).toEqual(["0x10"]);
});

it("pages observed references and preserves provider completeness through MCP", async () => {
  const addresses = ["0x90", "0x70", "0x80"];
  let providerTruncated: boolean | undefined = false;
  const client = await connect({
    execute: async (operation) => {
      if (operation === "list_names") return ok(inventory({ "0x10": "entry" }));
      if (operation !== "xrefs") throw new Error(`Unexpected ${operation}`);
      return {
        ok: true,
        value: createAnalysisExecution(
          addresses,
          { id: "fixture", name: "Fixture analysis provider", version: "1" },
          providerTruncated === undefined
            ? {}
            : { referencesTruncated: providerTruncated },
        ),
      };
    },
  });
  const query = (paging: { limit?: number; offset?: number } = {}) =>
    client.callTool({
      name: "find_xrefs_to_name",
      arguments: { name: "entry", ...paging },
    });
  const resolved = { status: "resolved", name: "entry", address: "0x10" };
  expect(jsonResult(await query())).toEqual({ ...resolved, xrefs: addresses });

  for (const [paging, xrefs] of [
    [{ offset: 1, limit: 1 }, ["0x70"]],
    [{ offset: 1 }, ["0x70", "0x80"]],
    [{ offset: 3 }, []],
  ] as const) {
    expect(jsonResult(await query(paging))).toEqual({
      ...resolved,
      xrefs,
      observed_xrefs: 3,
      total_xrefs: 3,
      provider_truncated: false,
      truncated: true,
    });
  }

  for (const status of [false, true, undefined]) {
    providerTruncated = status;
    expect(jsonResult(await query({ limit: 20_000 }))).toEqual({
      ...resolved,
      xrefs: addresses,
      observed_xrefs: 3,
      total_xrefs: status === false ? 3 : null,
      provider_truncated: status ?? null,
      truncated: status ?? null,
    });
  }
  expect((await query({ limit: 0 })).isError).toBe(true);
  expect((await query({ offset: -1 })).isError).toBe(true);
});

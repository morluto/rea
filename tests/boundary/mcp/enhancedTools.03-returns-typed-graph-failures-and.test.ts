import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { AnalysisOutputError } from "../../../src/domain/errors.js";
import {} from "../../../src/domain/jsonValue.js";
import { err } from "../../../src/domain/result.js";

import {
  closeEnhancedToolResources,
  connect,
  inventory,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
  it("returns typed graph failures and stable unresolved-name results", async () => {
    const tools = new EnhancedTools({
      execute: (name) =>
        name === "procedure_callees"
          ? Promise.resolve(err(new AnalysisOutputError(name, "failed")))
          : Promise.resolve(ok(inventory({}))),
    });

    const graph = await tools.execute("get_call_graph", {
      address: "0x1",
      direction: "forward",
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

  it("traverses the complete reachable call graph and stops at cycles", async () => {
    const calls: string[] = [];
    const tools = new EnhancedTools({
      execute: (name, arguments_) => {
        if (name !== "procedure_callees") return Promise.resolve(ok([]));
        const address = String(arguments_.procedure);
        calls.push(address);
        const next = Number.parseInt(address.slice(2), 16) + 1;
        return Promise.resolve(
          ok(next <= 8 ? [`0x${next.toString(16)}`] : ["0x2"]),
        );
      },
    });

    const result = await tools.execute("get_call_graph", {
      address: "0x1",
      direction: "forward",
    });

    expect(calls).toEqual([
      "0x1",
      "0x2",
      "0x3",
      "0x4",
      "0x5",
      "0x6",
      "0x7",
      "0x8",
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        "0": [{ address: "0x1", calls: ["0x2"], status: "ok" }],
        "7": [{ address: "0x8", calls: ["0x2"], status: "ok" }],
      },
    });
  });

  it("uses every procedure in one complete inventory", async () => {
    const calls: string[] = [];
    const client = await connect({
      execute: (name) => {
        calls.push(name);
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
    expect(calls).toEqual(["list_procedures"]);
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

    const result = await new EnhancedTools(analysis).execute(
      "analyze_swift_types",
      {},
      controller.signal,
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});

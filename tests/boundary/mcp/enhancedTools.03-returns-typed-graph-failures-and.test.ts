import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
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
        name === "procedure_address"
          ? Promise.resolve(ok("0x1"))
          : name === "procedure_callees"
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

    const result = await new EnhancedTools(analysis).execute(
      "analyze_swift_types",
      {},
      controller.signal,
    );

    expect(calls).toBe(1);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});

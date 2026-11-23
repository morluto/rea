import { describe, expect, it } from "vitest";

import { traceCallPath } from "./CallPathTracing.js";
import { createAnalysisExecution } from "../ports/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";

const input = { start: "entry", direction: "forward" as const };
const provider = { id: "fixture", name: "Fixture", version: "1" };

describe("call-path traversal cancellation ownership", () => {
  for (const phase of ["selection", "relationship"] as const)
    for (const reason of [null, { requested: "stop after provider reply" }])
      it(`preserves the exact reason at the ${phase} continuation (${reason === null ? "null" : "object"})`, async () => {
        const controller = new AbortController();
        const result = await traceCallPath(
          async () => {
            if (phase === "selection") controller.abort(reason);
            return ok("0x1000");
          },
          async () => {
            controller.abort(reason);
            return ok(createAnalysisExecution([], provider));
          },
          input,
          controller.signal,
        );
        if (result.ok) throw new Error("Expected cancellation");
        expect(result.error).toBeInstanceOf(AnalysisCancelledError);
        expect(result.error.cause).toBe(reason);
      });

  it("preserves a selected provider failure when cancellation arrives with its reply", async () => {
    const controller = new AbortController();
    const failure = new AnalysisOutputError(
      "procedure_callees",
      "invalid fixture reply",
    );
    const result = await traceCallPath(
      async () => ok("0x1000"),
      async () => {
        controller.abort({ requested: "stop" });
        return err(failure);
      },
      input,
      controller.signal,
    );
    expect(result).toEqual(err(failure));
  });
});

describe("call-path traversal bounds", () => {
  const edges: Readonly<Record<string, readonly string[]>> = {
    "0x1000": ["0x2000", "0x2100"],
    "0x2000": ["0x3000"],
    "0x2100": ["0x3100"],
    "0x3000": ["0x4000"],
  };
  const resolveAddress = async (
    _op: string,
    args: Readonly<Record<string, unknown>>,
  ) => ok(String(args.procedure));
  const observeEdges = async (
    _op: string,
    args: Readonly<Record<string, unknown>>,
  ) =>
    ok(
      createAnalysisExecution(
        [...(edges[String(args.procedure)] ?? [])],
        provider,
        {
          relationshipCoverage: { status: "complete" },
        },
      ),
    );

  it("stops at max_depth and marks an unreached goal unknown with partial discovery", async () => {
    const result = await traceCallPath(resolveAddress, observeEdges, {
      start: "0x1000",
      goal: "0x3000",
      direction: "forward",
      max_depth: 1,
    });
    if (!result.ok) throw new Error("Expected bounded trace result");
    expect(result.value).toMatchObject({
      goal_status: "unknown",
      truncated: true,
      search_scope: {
        discovery: "partial",
        observed_goal_status: "unknown",
      },
      traversal_path: [],
    });
    const residual = (result.value as { residual_unknowns: string[] })
      .residual_unknowns;
    expect(residual.some((line) => line.includes("max_depth 1"))).toBe(true);
  });

  it("reaches a goal within max_depth without marking the trace truncated", async () => {
    const result = await traceCallPath(resolveAddress, observeEdges, {
      start: "0x1000",
      goal: "0x2000",
      direction: "forward",
      max_depth: 1,
    });
    if (!result.ok) throw new Error("Expected bounded trace result");
    expect(result.value).toMatchObject({
      goal_status: "reached",
      truncated: false,
      traversal_path: ["0x1000", "0x2000"],
    });
  });

  it("stops at max_nodes and reports unexpanded queued procedures", async () => {
    const result = await traceCallPath(resolveAddress, observeEdges, {
      start: "0x1000",
      goal: "0x4000",
      direction: "forward",
      max_nodes: 2,
    });
    if (!result.ok) throw new Error("Expected bounded trace result");
    expect(result.value).toMatchObject({
      goal_status: "unknown",
      truncated: true,
      search_scope: { discovery: "partial" },
    });
    const residual = (result.value as { residual_unknowns: string[] })
      .residual_unknowns;
    expect(residual.some((line) => line.includes("max_nodes 2"))).toBe(true);
  });
});

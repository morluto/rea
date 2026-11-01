import { afterEach, describe, expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import type { RelationshipCoverage } from "../../../src/domain/relationshipCoverage.js";
import { err, ok } from "../../../src/domain/result.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

describe("multi-goal call paths", () => {
  it("traces several goals once, retaining shortest paths and complete backward roots", async () => {
    const reads: string[] = [];
    const graph: Record<string, string[]> = {
      "0x1": ["0x2", "0x3"],
      "0x2": ["0x3", "0x4"],
      "0x3": ["0x4"],
      "0x4": [],
    };
    const client = await connect({
      execute: async (name, input) => {
        const address = String(input.procedure);
        if (name === "procedure_address")
          return ok(
            createAnalysisExecution(address, {
              id: "fixture",
              name: "fixture",
              version: "1",
            }),
          );
        if (name !== "procedure_callers") throw new Error(`Unexpected ${name}`);
        reads.push(address);
        return ok(
          createAnalysisExecution(
            graph[address] ?? [],
            { id: "fixture", name: "fixture", version: "1" },
            { relationshipCoverage: { status: "complete" } },
          ),
        );
      },
    });
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: {
        start: "0x1",
        goals: ["0x3", "0x4", "0x9"],
        direction: "backward",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        goal_results: [
          {
            goal: "0x3",
            goal_status: "reached",
            traversal_path: ["0x1", "0x3"],
          },
          {
            goal: "0x4",
            goal_status: "reached",
            traversal_path: ["0x1", "0x2", "0x4"],
          },
          { goal: "0x9", goal_status: "not_reached", traversal_path: [] },
        ],
        roots: ["0x4"],
        truncated: false,
      },
    });
    expect(reads).toEqual(["0x1", "0x2", "0x3", "0x4"]);
  });
});

describe("multi-goal uncertainty and compatibility", () => {
  it.each([
    { status: "partial", limitations: ["Some callers are unresolved"] },
    { status: "unknown", reason: "No caller coverage supplied" },
  ] satisfies RelationshipCoverage[])(
    "keeps $status empty callers unknown and excludes them from roots",
    async (coverage) => {
      const client = await connect({
        execute: async (name, input) =>
          ok(
            createAnalysisExecution(
              name === "procedure_address" ? String(input.procedure) : [],
              { id: "fixture", name: "fixture", version: "1" },
              { relationshipCoverage: coverage },
            ),
          ),
      });
      const result = await client.callTool({
        name: "trace_call_path",
        arguments: {
          start: "0x1",
          goals: ["0x1", "0x2"],
          direction: "backward",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: {
          goal_results: [
            { goal: "0x1", goal_status: "reached", traversal_path: ["0x1"] },
            { goal: "0x2", goal_status: "unknown", traversal_path: [] },
          ],
          roots: [],
          truncated: true,
        },
      });
    },
  );

  it.each(["malformed", "failed"])(
    "retains %s expansions without fabricating roots or negatives",
    async (mode) => {
      const client = await connect({
        execute: async (name, input) => {
          if (name !== "procedure_address" && mode === "failed")
            return err(new AnalysisOutputError(name, "fixture failure"));
          return ok(
            createAnalysisExecution(
              name === "procedure_address"
                ? String(input.procedure)
                : { callers: [null] },
              { id: "fixture", name: "fixture", version: "1" },
              { relationshipCoverage: { status: "complete" } },
            ),
          );
        },
      });
      const result = await client.callTool({
        name: "trace_call_path",
        arguments: { start: "0x1", goals: ["0x2"], direction: "backward" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: {
          roots: [],
          goal_results: [{ goal_status: "unknown" }],
          failures: [{ address: "0x1" }],
          truncated: true,
        },
      });
    },
  );
});

describe("multi-goal input and legacy controls", () => {
  it.each([
    { goals: [] },
    { goals: [""] },
    { goals: [42] },
    { goals: "0x2" },
    { goal: "0x2", goals: ["0x3"] },
  ])(
    "rejects invalid goal selections before provider work: %j",
    async (selection) => {
      const client = await connect({
        execute: async () => {
          throw new Error("invalid input reached provider");
        },
      });
      const result = await client.callTool({
        name: "trace_call_path",
        arguments: { start: "0x1", ...selection },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it("preserves legacy early stopping but exhausts a batch even after every goal is reached", async () => {
    const reads: string[] = [];
    const client = await connect({
      execute: async (name, input) => {
        const address = String(input.procedure);
        if (name !== "procedure_address") reads.push(address);
        return ok(
          createAnalysisExecution(
            name === "procedure_address"
              ? address
              : address === "0x1"
                ? ["0x2"]
                : [],
            { id: "fixture", name: "fixture", version: "1" },
            { relationshipCoverage: { status: "complete" } },
          ),
        );
      },
    });
    const single = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2", direction: "backward" },
    });
    expect(single.structuredContent).toMatchObject({
      normalized_result: {
        goal: "0x2",
        goal_status: "reached",
        traversal_path: ["0x1", "0x2"],
        roots: [],
      },
    });
    expect(reads).toEqual(["0x1"]);
    reads.length = 0;
    const batch = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goals: ["0x2", "0x2"], direction: "backward" },
    });
    expect(batch.structuredContent).toMatchObject({
      normalized_result: {
        goal: null,
        goal_status: "not_requested",
        traversal_path: [],
        roots: ["0x2"],
        goal_results: [
          { goal: "0x2", traversal_path: ["0x1", "0x2"] },
          { goal: "0x2", traversal_path: ["0x1", "0x2"] },
        ],
      },
    });
    expect(reads).toEqual(["0x1", "0x2"]);
    reads.length = 0;
    const forward = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goals: ["0x2"] },
    });
    expect(forward.structuredContent).toMatchObject({
      normalized_result: {
        roots: [],
        goal_results: [{ goal_status: "reached" }],
      },
    });
  });
});

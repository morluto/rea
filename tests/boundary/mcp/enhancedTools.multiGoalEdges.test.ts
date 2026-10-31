import { afterEach, describe, expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

const observed = (value: unknown) =>
  ok(
    createAnalysisExecution(
      value,
      { id: "fixture", name: "fixture", version: "1" },
      {
        relationshipCoverage: { status: "complete" },
      },
    ),
  );

afterEach(closeEnhancedToolResources);

describe("multi-goal selector identity", () => {
  it("resolves aliases once per distinct selector and preserves request order and origin", async () => {
    const calls: unknown[] = [];
    const client = await connect({
      execute: async (name, input, options) => {
        calls.push([name, input.procedure, options?.selectorOrigin]);
        if (name === "procedure_address")
          return observed(input.procedure === "start" ? "0x1" : "0x2");
        if (name !== "procedure_callees") throw new Error(`Unexpected ${name}`);
        return observed(input.procedure === "0x1" ? ["0x2"] : []);
      },
    });
    const arguments_ = {
      start: "start",
      goals: ["alias", "start", "0x2", "alias"],
    };
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: arguments_,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      parameters: arguments_,
      normalized_result: {
        goal_results: [
          {
            goal: "0x2",
            goal_status: "reached",
            traversal_path: ["0x1", "0x2"],
          },
          { goal: "0x1", goal_status: "reached", traversal_path: ["0x1"] },
          {
            goal: "0x2",
            goal_status: "reached",
            traversal_path: ["0x1", "0x2"],
          },
          {
            goal: "0x2",
            goal_status: "reached",
            traversal_path: ["0x1", "0x2"],
          },
        ],
        roots: [],
      },
    });
    expect(calls).toEqual([
      ["procedure_address", "start", undefined],
      ["procedure_address", "alias", undefined],
      ["procedure_address", "0x2", undefined],
      ["procedure_callees", "0x1", "provider"],
      ["procedure_callees", "0x2", "provider"],
    ]);
  });

  it.each([
    {
      failure: new AnalysisInputError("procedure_address"),
      code: "invalid_request",
    },
    {
      failure: new AnalysisCancelledError("procedure_address"),
      code: "cancelled",
    },
  ])(
    "stops at a $code goal lookup without resolving later goals or traversing",
    async ({ failure, code }) => {
      const calls: unknown[] = [];
      const client = await connect({
        execute: async (name, input) => {
          calls.push([name, input.procedure]);
          if (name !== "procedure_address")
            throw new Error(`Unexpected ${name}`);
          return input.procedure === "bad" ? err(failure) : observed("0x1");
        },
      });
      const result = await client.callTool({
        name: "trace_call_path",
        arguments: { start: "start", goals: ["bad", "later"] },
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject({ error: { code } });
      expect(calls).toEqual([
        ["procedure_address", "start"],
        ["procedure_address", "bad"],
      ]);
    },
  );
});

describe("multi-goal graph boundaries", () => {
  it.each(["forward", "backward"])(
    "terminates a %s cycle without inventing roots or repeating reads",
    async (direction) => {
      const reads: string[] = [];
      const client = await connect({
        execute: async (name, input) => {
          const address = String(input.procedure);
          if (name === "procedure_address") return observed(address);
          const relation =
            direction === "forward" ? "procedure_callees" : "procedure_callers";
          if (name !== relation) throw new Error(`Unexpected ${name}`);
          reads.push(address);
          return observed(address === "0x1" ? ["0x1", "0x2", "0x2"] : ["0x1"]);
        },
      });
      const result = await client.callTool({
        name: "trace_call_path",
        arguments: { start: "0x1", goals: ["0x2", "0x9"], direction },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: {
          roots: [],
          truncated: false,
          traversal: { nodes_visited: 2 },
          goal_results: [
            {
              goal: "0x2",
              goal_status: "reached",
              traversal_path: ["0x1", "0x2"],
            },
            { goal: "0x9", goal_status: "not_reached", traversal_path: [] },
          ],
        },
      });
      expect(reads).toEqual(["0x1", "0x2"]);
    },
  );

  it("collects every confirmed backward root even without requested goals", async () => {
    const client = await connect({
      execute: async (name, input) => {
        if (name === "procedure_address") return observed(input.procedure);
        if (name !== "procedure_callers") throw new Error(`Unexpected ${name}`);
        return observed(input.procedure === "0x1" ? ["0x3", "0x2"] : []);
      },
    });
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", direction: "backward" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        goal: null,
        goal_status: "not_requested",
        goal_results: [],
        roots: ["0x2", "0x3"],
        truncated: false,
      },
    });
  });
});

describe("multi-goal mixed coverage", () => {
  it("keeps a discovered path and confirmed root while missing coverage makes other goals unknown", async () => {
    const client = await connect({
      execute: async (name, input) => {
        if (name === "procedure_address") return observed(input.procedure);
        if (name !== "procedure_callers") throw new Error(`Unexpected ${name}`);
        if (input.procedure === "0x1") return observed(["0x2", "0x3"]);
        if (input.procedure === "0x3")
          return ok(
            createAnalysisExecution([], {
              id: "fixture",
              name: "fixture",
              version: "1",
            }),
          );
        return observed([]);
      },
    });
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: {
        start: "0x1",
        goals: ["0x2", "0x3", "0x9"],
        direction: "backward",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        roots: ["0x2"],
        truncated: true,
        relationship_coverage: { "0x3": { status: "unknown" } },
        goal_results: [
          {
            goal: "0x2",
            goal_status: "reached",
            traversal_path: ["0x1", "0x2"],
          },
          {
            goal: "0x3",
            goal_status: "reached",
            traversal_path: ["0x1", "0x3"],
          },
          { goal: "0x9", goal_status: "unknown", traversal_path: [] },
        ],
      },
    });
  });
});

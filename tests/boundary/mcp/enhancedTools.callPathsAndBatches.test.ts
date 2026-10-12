import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import type { RelationshipCoverage } from "../../../src/domain/relationshipCoverage.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";

import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

const relationshipExecution = (
  result: unknown,
  limitations: readonly string[] = [],
  relationshipCoverage?: RelationshipCoverage,
) =>
  resultOk(
    createAnalysisExecution(
      result,
      { id: "fixture", name: "Fixture analysis provider", version: "1" },
      {
        limitations,
        ...(relationshipCoverage === undefined ? {} : { relationshipCoverage }),
      },
    ),
  );

describe("enhanced MCP tools", () => {
  it("preserves per-node relationship limitations and keeps observed edges", async () => {
    const limitation = "ARM64 call targets are only partially resolved.";
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return relationshipExecution(
          arguments_.procedure === "0x1" ? ["0x2"] : [],
          arguments_.procedure === "0x1" ? [limitation] : [],
          arguments_.procedure === "0x1"
            ? { status: "partial", limitations: [limitation] }
            : { status: "complete" },
        );
      },
    });
    const graph = await client.callTool({
      name: "get_call_graph",
      arguments: { address: "0x1", direction: "forward" },
    });
    expect(graph.isError).not.toBe(true);
    expect(graph.structuredContent).toMatchObject({
      normalized_result: {
        graph: {
          "0": [
            {
              address: "0x1",
              status: "ok",
              calls: ["0x2"],
              limitations: [limitation],
              relationship_coverage: {
                status: "partial",
                limitations: [limitation],
              },
            },
          ],
        },
        limitations: [limitation],
      },
    });
    const trace = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2" },
    });
    expect(trace.isError).not.toBe(true);
    expect(trace.structuredContent).toMatchObject({
      normalized_result: {
        goal_status: "reached",
        traversal_path: ["0x1", "0x2"],
        edges: [{ source_address: "0x1", target_address: "0x2" }],
        truncated: true,
        residual_unknowns: [
          `Call relationships for 0x1 are limited: ${limitation}`,
        ],
      },
    });
  });

  it("keeps generic provider caveats visible without truncating complete relationships", async () => {
    const caveat = "Decompiler output may omit indirect calls.";
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return relationshipExecution(
          arguments_.procedure === "0x1" ? ["0x2"] : [],
          [caveat],
          { status: "complete" },
        );
      },
    });

    const graph = await client.callTool({
      name: "get_call_graph",
      arguments: { address: "0x1", direction: "forward" },
    });
    expect(graph.structuredContent).toMatchObject({
      normalized_result: {
        graph: {
          "0": [
            { status: "ok", relationship_coverage: { status: "complete" } },
          ],
          "1": [
            { status: "ok", relationship_coverage: { status: "complete" } },
          ],
        },
        limitations: [caveat],
      },
    });
    expect(JSON.stringify(graph.structuredContent)?.split(caveat)).toHaveLength(
      2,
    );

    const trace = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2" },
    });
    expect(trace.structuredContent).toMatchObject({
      normalized_result: {
        truncated: false,
        residual_unknowns: [],
        limitations: expect.arrayContaining([expect.stringContaining(caveat)]),
        relationship_coverage: { "0x1": { status: "complete" } },
      },
    });
  });

  it("keeps unclassified legacy caveats on nodes with unknown coverage", async () => {
    const caveat = "This legacy provider does not classify call limitations.";
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return relationshipExecution([], [caveat]);
      },
    });

    const graph = await client.callTool({
      name: "get_call_graph",
      arguments: { address: "0x1", direction: "forward" },
    });
    expect(graph.structuredContent).toMatchObject({
      normalized_result: {
        graph: {
          "0": [
            {
              status: "ok",
              relationship_coverage: { status: "unknown" },
              limitations: [
                "Provider did not report relationship coverage.",
                caveat,
              ],
            },
          ],
        },
        limitations: [caveat],
      },
    });
  });
});

describe("trace_call_path MCP outcome semantics", () => {
  it("reports an unreachable goal as unknown when relationship coverage is partial", async () => {
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return relationshipExecution([], [], {
          status: "partial",
          limitations: ["one or more callees may be missing"],
        });
      },
    });

    const trace = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2" },
    });
    expect(trace.isError).not.toBe(true);
    expect(trace.structuredContent).toMatchObject({
      normalized_result: {
        goal_status: "unknown",
        truncated: true,
        relationship_coverage: { "0x1": { status: "partial" } },
      },
    });
  });

  it("reports an unreachable goal as unknown when an expansion fails", async () => {
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            name,
            "relationship read unavailable",
          ),
        );
      },
    });

    const trace = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2" },
    });
    expect(trace.isError).not.toBe(true);
    expect(trace.structuredContent).toMatchObject({
      normalized_result: {
        goal_status: "unknown",
        failures: [{ address: "0x1" }],
        truncated: true,
      },
    });
  });

  it("reports an unreachable goal as absent after complete traversal", async () => {
    const client = await connect({
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        return relationshipExecution([], [], { status: "complete" });
      },
    });

    const trace = await client.callTool({
      name: "trace_call_path",
      arguments: { start: "0x1", goal: "0x2" },
    });
    expect(trace.isError).not.toBe(true);
    expect(trace.structuredContent).toMatchObject({
      normalized_result: {
        goal_status: "not_reached",
        truncated: false,
        residual_unknowns: [],
      },
    });
  });

  it("propagates cancellation during expansion without visiting another frontier", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const client = await connect({
      execute: async (name, arguments_, options) => {
        calls.push(name);
        if (name === "procedure_address")
          return relationshipExecution(String(arguments_.procedure));
        if (name !== "procedure_callees")
          throw new Error(`Unexpected operation: ${name}`);
        controller.abort();
        if (options?.signal?.aborted !== true)
          throw new Error("provider request was not cancelled");
        return err(new AnalysisCancelledError(name));
      },
    });

    await expect(
      client.callTool(
        {
          name: "trace_call_path",
          arguments: { start: "0x1", goal: "0x3" },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([
      "procedure_address",
      "procedure_address",
      "procedure_callees",
    ]);
  });
});

describe("enhanced MCP batches", () => {
  it("returns every batch item in caller order with its own result", async () => {
    const addresses = Array.from(
      { length: 37 },
      (_, index) => `0x${index.toString(16)}`,
    );
    const analysis: AnalysisOperationPort = {
      execute: async (name, arguments_) => {
        if (name === "procedure_address")
          return ok(String(arguments_.procedure));
        if (name === "address_name")
          return ok(`name for ${String(arguments_.address)}`);
        if (name !== "procedure_pseudo_code")
          throw new Error(`Unexpected operation: ${name}`);
        await new Promise((resolve) => setImmediate(resolve));
        return ok(`pseudo for ${String(arguments_.procedure)}`);
      },
    };
    const client = await connect(analysis);
    const result = await client.callTool({
      name: "batch_decompile",
      arguments: {
        addresses,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        items: addresses.map((address) => ({
          address,
          procedure: {
            status: "resolved",
            address,
            name: `name for ${address}`,
          },
          status: "ok",
          pseudocode: `pseudo for ${address}`,
        })),
        total: addresses.length,
        succeeded: addresses.length,
        failed: 0,
      },
    });
  });

  it("returns ordered typed batch failures and zero counts for empty input", async () => {
    const tools = new EnhancedTools({
      execute: (name, arguments_) =>
        name === "procedure_address"
          ? Promise.resolve(ok(String(arguments_.procedure)))
          : name === "address_name"
            ? Promise.resolve(ok(null))
            : arguments_.procedure === "0x2"
              ? Promise.resolve(
                  err(new AnalysisOutputError("decompile", "failed")),
                )
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
          {
            address: "0x1",
            procedure: { status: "resolved", address: "0x1", name: null },
            status: "ok",
            pseudocode: "pseudo",
          },
          {
            address: "0x2",
            procedure: { status: "resolved", address: "0x2", name: null },
            status: "error",
            error: {
              code: "unreadable_output",
              category: "execution_failure",
              details: { operation: "decompile", reason: "failed" },
              message:
                "Analysis returned an unreadable result. Run `rea doctor` and review the reported details; repeating the unchanged request is not expected to succeed.",
              retryable: false,
              remediation: {
                action:
                  "Analysis returned an unreadable result. Run `rea doctor` and review the reported details; repeating the unchanged request is not expected to succeed.",
              },
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
});

describe("batch procedure identity", () => {
  it("keeps selectors separate from canonical entries and preserves partial identity failures", async () => {
    const client = await connect({
      execute: async (operation, input) => {
        if (operation === "procedure_address") {
          if (input.procedure === "unknown")
            return err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                operation,
                "identity unavailable",
              ),
            );
          if (input.procedure === "malformed") return ok({ address: "0x1000" });
          return ok(
            input.procedure === "external" ? "EXTERNAL:00000001" : "0x1000",
          );
        }
        if (operation === "address_name") {
          return input.address === "EXTERNAL:00000001"
            ? err(new AnalysisOutputError(operation, "label lookup failed"))
            : ok("observed_name");
        }
        return input.procedure === "missing"
          ? err(new AnalysisOutputError(operation, "no containing procedure"))
          : ok(
              `pseudocode label is deliberately unrelated: ${String(input.procedure)}`,
            );
      },
    });
    const selectors = [
      "0x1000",
      "0x1004",
      "alias",
      "external",
      "unknown",
      "malformed",
    ];
    const result = await client.callTool({
      name: "batch_decompile",
      arguments: { addresses: selectors },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        items: [
          ...selectors.slice(0, 3).map((address) => ({
            address,
            procedure: {
              status: "resolved",
              address: "0x1000",
              name: "observed_name",
            },
            pseudocode: "pseudocode label is deliberately unrelated: 0x1000",
          })),
          {
            address: "external",
            procedure: {
              status: "resolved",
              address: "EXTERNAL:00000001",
              name: null,
              name_error: { code: "unreadable_output" },
            },
          },
          {
            address: "unknown",
            status: "ok",
            procedure: {
              status: "unknown",
              error: { code: "capability_unavailable" },
            },
          },
          {
            address: "malformed",
            status: "ok",
            procedure: {
              status: "unknown",
              error: { code: "unreadable_output" },
            },
          },
        ],
        total: 6,
        succeeded: 6,
        failed: 0,
      },
    });
  });
});

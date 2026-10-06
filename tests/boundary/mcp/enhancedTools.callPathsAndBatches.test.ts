import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";

import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
  it("returns Evidence IDs and a complete call path", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: {
        start: "0x1",
        goal: "0x3",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      result: {
        goal_status: "reached",
        nodes: expect.arrayContaining([
          expect.objectContaining({ address: "0x1" }),
          expect.objectContaining({ address: "0x3" }),
        ]),
        truncated: false,
      },
    });
  });

  it("returns every batch item in caller order with its own result", async () => {
    const addresses = Array.from(
      { length: 37 },
      (_, index) => `0x${index.toString(16)}`,
    );
    const analysis: AnalysisOperationPort = {
      execute: async (name, arguments_) => {
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
      result: {
        items: addresses.map((address) => ({
          address,
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
              code: "unreadable_output",
              category: "execution_failure",
              details: { operation: "decompile", reason: "failed" },
              message:
                "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
              retryable: false,
              remediation: {
                action:
                  "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
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

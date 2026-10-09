import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";

import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
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

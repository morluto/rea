import { afterEach, describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { GHIDRA_SWIFT_INVENTORY } from "../../fixtures/swift/ghidraInventory.js";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

describe("Golden Swift inventory through MCP", () => {
  it("classifies and filters a golden inventory without losing source aliases", async () => {
    const client = await connect({
      execute: async (operation) =>
        ok(
          operation === "list_procedures"
            ? GHIDRA_SWIFT_INVENTORY.procedures
            : GHIDRA_SWIFT_INVENTORY.symbols,
        ),
    });
    const classify = async (arguments_: Record<string, string>) => {
      const reply = await client.callTool({
        name: "analyze_swift_types",
        arguments: arguments_,
      });
      expect(reply.isError).not.toBe(true);
      return jsonResult(reply);
    };
    const unclassified = [
      {
        name: "main::$swiftIndirect",
        reason: "category_not_decoded",
        mangled_names: ["_$s4main13swiftIndirectySiAA7Scoring_p_SitF"],
      },
    ];
    expect(await classify({})).toMatchObject({
      total: 6,
      categories: {
        structs: {
          count: 5,
          items: expect.not.arrayContaining([
            expect.objectContaining({ address: "0x100000c0c" }),
          ]),
        },
      },
      unclassified,
    });
    expect(await classify({ category: "structs" })).toMatchObject({
      total: 5,
      categories: { structs: { count: 5 }, other: { count: 0 } },
      unclassified,
    });
    expect(
      await classify({ category: "structs", pattern: "Pair" }),
    ).toMatchObject({
      total: 3,
      categories: {
        structs: {
          items: [
            { address: "0x100000954", name: "main::Pair::init" },
            { address: "0x1000009bc", name: "main::Pair::set_a" },
            {
              address: "0x100000ab4",
              name: "main::Pair::typeMetadataAccessor",
            },
          ],
        },
      },
      unclassified: [],
    });
    const pair = {
      address: "0x100000ab4",
      name: "main::Pair::typeMetadataAccessor",
      mangled_names: ["_$s4main4PairVMa"],
    };
    expect(await classify({ pattern: "_$s4main4PairVMa" })).toMatchObject({
      total: 1,
      categories: { structs: { items: [pair] } },
      unclassified: [],
    });
    expect(
      await classify({ category: "structs", pattern: "typeMetadataAccessor" }),
    ).toMatchObject({
      total: 2,
      categories: {
        structs: {
          items: [
            pair,
            {
              address: "0x100000ac4",
              name: "main::Scorer::typeMetadataAccessor",
              mangled_names: ["_$s4main6ScorerVMa"],
            },
          ],
        },
      },
      unclassified: [],
    });
  });
});

describe("Swift inventory failures", () => {
  it("retains known facts when a provider has no symbol inventory", async () => {
    const client = await connect({
      execute: async (operation) =>
        operation === "list_procedures"
          ? ok([{ address: "0x1", value: "$s4main4PairVMa" }])
          : err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                operation,
                "no symbols",
              ),
            ),
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: { category: "structs" },
    });
    expect(result.isError).not.toBe(true);
    expect(jsonResult(result)).toMatchObject({
      total: 1,
      symbol_inventory_error: { code: "capability_unavailable" },
      limitations: expect.arrayContaining([
        expect.stringContaining("symbol inventory is unavailable"),
      ]),
    });
  });

  it.each([
    new AnalysisOutputError("list_names", "malformed symbols"),
    new AnalysisArtifactChangedError(
      "list_names",
      "/fixture",
      "fixture changed",
    ),
  ])("preserves symbol-inventory failures: $_tag", async (failure) => {
    const tools = new EnhancedTools({
      execute: async (operation) =>
        operation === "list_procedures"
          ? ok([{ address: "0x1", value: "$s4main4PairVMa" }])
          : err(failure),
    });
    expect(
      await tools.executeValidated({ name: "analyze_swift_types", input: {} }),
    ).toEqual(err(failure));
  });

  it("returns cancellation during the symbol join", async () => {
    const controller = new AbortController();
    const reason = { stage: "symbol-join" };
    const tools = new EnhancedTools({
      execute: async (operation) => {
        if (operation === "list_names") controller.abort(reason);
        return ok([{ address: "0x1", value: "$s4main4PairVMa" }]);
      },
    });
    const result = await tools.executeValidated(
      { name: "analyze_swift_types", input: {} },
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "list_names" },
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
  });
});

describe("Swift category uncertainty through MCP", () => {
  it("keeps unsupported nested Unicode names unresolved through MCP filters", async () => {
    const names = [
      "_$s6Nested8EnvelopeV007IhuqBAbO8describeSSyF",
      "_$s6Nested8EnvelopeV007jvrtDBlCAEycfC",
      "_$s6Nested8EnvelopeV007jvrtDBlCMa",
    ];
    const procedures = [
      ...names.map((name, index) => ({
        address: `0x${String(index + 1)}`,
        value: name,
      })),
      { address: "0x10", value: "_$s6Nested8EnvelopeVMa" },
      { address: "0x11", value: "_$s6Nested8EnvelopeV5InnerCMa" },
      { address: "0x12", value: "_$s6Nested8EnvelopeV5InnerC6methodyyF" },
    ];
    const client = await connect({
      execute: async (operation) =>
        ok(operation === "list_procedures" ? procedures : []),
    });

    const all = jsonResult(
      await client.callTool({
        name: "analyze_swift_types",
        arguments: {},
      }),
    );
    expect(all).toMatchObject({
      total: 6,
      categories: {
        structs: {
          items: [{ name: "_$s6Nested8EnvelopeVMa" }],
        },
        classes: {
          items: [
            { name: "_$s6Nested8EnvelopeV5InnerCMa" },
            { name: "_$s6Nested8EnvelopeV5InnerC6methodyyF" },
          ],
        },
        other: {
          items: names.map((name) => ({ name, mangled_names: [name] })),
        },
      },
      unclassified: names.map((name) => ({
        name,
        mangled_names: [name],
        reason: "category_not_decoded",
      })),
    });

    for (const category of ["classes", "enums"] as const) {
      const filtered = jsonResult(
        await client.callTool({
          name: "analyze_swift_types",
          arguments: { category },
        }),
      );
      const selected = category === "classes" ? 2 : 0;
      expect(filtered).toMatchObject({
        total: selected,
        categories: { [category]: { count: selected }, other: { count: 0 } },
        unclassified: names.map((name) => ({
          name,
          mangled_names: [name],
          reason: "category_not_decoded",
        })),
      });
    }
  });
});

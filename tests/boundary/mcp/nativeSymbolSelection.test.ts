import { afterEach, describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { err, type Result } from "../../../src/domain/result.js";
import { HopperRemoteError } from "../../../src/hopper/HopperErrors.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../../../src/ports/AnalysisProvider.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

const CALL_SITES = ["0x180001010", "0x180002020"];
const CALLERS = ["0x180001000", "0x180002000"];

type Call = { operation: string; parameters: Record<string, JsonValue> };

/**
 * Ghidra reports an import as an external function under its
 * library-qualified name, rejects a name as an `xrefs` address, and resolves
 * the imported leaf name as a procedure.
 */
const ghidraShaped = (calls: Call[]): AnalysisOperationPort => ({
  execute: async (operation, parameters) => {
    calls.push({ operation, parameters: { ...parameters } });
    const selector = parameters.address ?? parameters.procedure;
    switch (operation) {
      case "list_names":
        return observed([
          {
            address: "EXTERNAL:0x4d",
            value: "KERNEL32.DLL::VirtualAlloc",
            symbol: {
              primary: true,
              dynamic: false,
              external: true,
              type: "function",
              source: "imported",
            },
          },
          { address: "0x18004a168", value: "PTR_VirtualAlloc_18004a168" },
        ]);
      case "xrefs":
        return selector === "EXTERNAL:0x4d"
          ? observed(CALL_SITES)
          : err(
              new AnalysisInputError("xrefs", undefined, [
                {
                  path: ["address"],
                  reason: "invalid_format",
                  message: "Use hexadecimal digits",
                },
              ]),
            );
      case "procedure_callers":
        return selector === "VirtualAlloc" ||
          selector === "0x18004a168" ||
          selector === "EXTERNAL:0x4d"
          ? observed(CALLERS)
          : procedureMiss(operation, String(selector));
      case "resolve_containing_procedure":
        return containment(String(parameters.address));
      default:
        return procedureMiss(operation, String(selector));
    }
  },
});

/**
 * Hopper reports the imported name without its library or symbol facts, and
 * answers incoming references only for an address outside every procedure.
 */
const hopperShaped = (calls: Call[]): AnalysisOperationPort => ({
  execute: async (operation, parameters) => {
    calls.push({ operation, parameters: { ...parameters } });
    const selector = parameters.address ?? parameters.procedure;
    switch (operation) {
      case "list_names":
        return observed([
          { address: "0x18004a168", value: "imp_VirtualAlloc" },
          { address: "0x401004", value: "inner" },
          { address: "0x18009a000", value: "timeout_label" },
          { address: "0x18009b000", value: "containment_timeout" },
          { address: "0x18007d2fc", value: "VirtualAlloc" },
        ]);
      case "xrefs":
        return selector === "0x18007d2fc" || selector === "VirtualAlloc"
          ? observed(CALL_SITES)
          : hopperMiss(operation, String(selector));
      case "procedure_callers":
        if (selector === "0x18009a000")
          return err(new AnalysisCancelledError("procedure_callers"));
        // An address inside a procedure would select that whole procedure.
        return selector === "0x18007d2fc" || selector === "0x401004"
          ? observed(CALLERS)
          : hopperMiss(operation, String(selector));
      case "resolve_containing_procedure":
        return containment(String(parameters.address));
      default:
        return hopperMiss(operation, String(selector));
    }
  },
});

const procedureMiss = (
  operation: string,
  procedure: string,
): Result<AnalysisExecution, AnalysisError> =>
  err(
    new AnalysisInputError(operation, { conformsToInputContract: true }, [
      {
        path: ["procedure"],
        reason: "invalid_value",
        message: `Unknown Ghidra procedure name or address: ${procedure}`,
      },
    ]),
  );

const containment = (address: string) =>
  address === "0x18009b000"
    ? err(new AnalysisCancelledError("resolve_containing_procedure"))
    : observed(
        address === "EXTERNAL:0x4d"
          ? {
              query_address: address,
              found: true,
              procedure: {
                address,
                name: "KERNEL32.DLL::VirtualAlloc",
                symbol: null,
                classification: null,
                body: { available: false, reason: "external" },
              },
            }
          : address === "0x401004"
            ? {
                query_address: address,
                found: true,
                procedure: {
                  address: "0x401000",
                  name: "entry",
                  symbol: null,
                  classification: null,
                  body: { available: false, reason: "unavailable" },
                },
              }
            : {
                query_address: address,
                found: false,
                procedure: null,
                reason: "not_in_procedure",
              },
      );

const hopperMiss = (
  operation: string,
  value: string,
): Result<AnalysisExecution, AnalysisError> =>
  err(
    new HopperRemoteError(-32000, "No procedure exists", {
      diagnosticType: "selector_not_found",
      operation,
      selector:
        value === "VirtualAlloc"
          ? { value, source: "symbol", address: "0x18007d2fc" }
          : { value, source: "unresolved" },
    }),
  );

const call = async (
  analysis: AnalysisOperationPort,
  name: string,
  arguments_: Record<string, JsonValue>,
) =>
  jsonResult(
    await (await connect(analysis)).callTool({ name, arguments: arguments_ }),
  );

describe("one name selector resolves the same way for every native operation", () => {
  it("resolves a bare import name to the Ghidra library-qualified import", async () => {
    const calls: Call[] = [];
    const analysis = ghidraShaped(calls);
    expect(
      await call(analysis, "find_xrefs_to_name", { name: "VirtualAlloc" }),
    ).toEqual({
      status: "resolved",
      name: "VirtualAlloc",
      resolved_name: "KERNEL32.DLL::VirtualAlloc",
      address: "EXTERNAL:0x4d",
      xrefs: CALL_SITES,
    });
    // The library qualifier compares without case, as PE loaders do.
    expect(
      await call(analysis, "find_xrefs_to_name", {
        name: "kernel32.dll::VirtualAlloc",
      }),
    ).toMatchObject({ status: "resolved", address: "EXTERNAL:0x4d" });
    // MCP xrefs retries a refused name by its resolved address.
    expect(await call(analysis, "xrefs", { address: "VirtualAlloc" })).toEqual(
      CALL_SITES,
    );
    expect(
      await call(analysis, "procedure_callers", { procedure: "VirtualAlloc" }),
    ).toEqual(CALLERS);
    // The shared owner resolves the name once; the provider answers by address.
    calls.length = 0;
    expect(
      await call(analysis, "procedure_callers", {
        procedure: "PTR_VirtualAlloc_18004a168",
      }),
    ).toEqual(CALLERS);
    expect(
      calls
        .filter(({ operation }) => operation === "procedure_callers")
        .map(({ parameters }) => parameters.procedure),
    ).toEqual(["0x18004a168"]);
  });

  it("resolves the Hopper imported name and asks incoming operations by address", async () => {
    const calls: Call[] = [];
    const analysis = hopperShaped(calls);
    expect(
      await call(analysis, "find_xrefs_to_name", { name: "VirtualAlloc" }),
    ).toEqual({
      status: "resolved",
      name: "VirtualAlloc",
      address: "0x18007d2fc",
      xrefs: CALL_SITES,
    });
    expect(
      await call(analysis, "procedure_callers", { procedure: "VirtualAlloc" }),
    ).toEqual(CALLERS);
    expect(
      calls
        .filter(({ operation }) => operation === "procedure_callers")
        .map(({ parameters }) => parameters.procedure),
    ).toEqual(["0x18007d2fc"]);
  });

  it("leaves a library-qualified name unresolved where the provider reports no library, naming the observed spelling", async () => {
    const analysis = hopperShaped([]);
    const candidates = [{ address: "0x18007d2fc", name: "VirtualAlloc" }];
    expect(
      await call(analysis, "find_xrefs_to_name", {
        name: "KERNEL32.DLL::VirtualAlloc",
      }),
    ).toEqual({
      status: "unresolved",
      name: "KERNEL32.DLL::VirtualAlloc",
      reason: "name_not_found",
      candidates,
    });
    expect(
      await call(analysis, "procedure_callers", {
        procedure: "KERNEL32.DLL::VirtualAlloc",
      }),
    ).toMatchObject({
      error: {
        code: "invalid_request",
        category: "invalid_input",
        details: {
          issues: [{ path: ["procedure"], reason: "invalid_value" }],
        },
        remediation: {
          action: expect.stringContaining("VirtualAlloc at 0x18007d2fc"),
        },
      },
    });
  });

  it("keeps the provider's refusal when the shared owner resolves nothing", async () => {
    expect(
      await call(hopperShaped([]), "procedure_callers", {
        procedure: "missing_fn",
      }),
    ).toMatchObject({
      error: {
        details: {
          diagnostic_type: "selector_not_found",
          selector: { value: "missing_fn", source: "unresolved" },
        },
      },
    });
  });

  it("keeps the provider's refusal of a name inside a procedure instead of selecting that procedure", async () => {
    const calls: Call[] = [];
    expect(
      await call(hopperShaped(calls), "procedure_callers", {
        procedure: "inner",
      }),
    ).toMatchObject({
      error: { details: { selector: { value: "inner" } } },
    });
    expect(
      calls
        .filter(({ operation }) => operation === "procedure_callers")
        .map(({ parameters }) => parameters.procedure),
    ).toEqual(["inner"]);
  });

  it("reports a retry's own failure rather than the earlier name refusal", async () => {
    expect(
      await call(hopperShaped([]), "procedure_callers", {
        procedure: "timeout_label",
      }),
    ).toMatchObject({ error: { code: "cancelled" } });
  });

  it("answers a library-qualified spelling the provider lookup refused at the import's exact entry", async () => {
    const calls: Call[] = [];
    expect(
      await call(ghidraShaped(calls), "procedure_callers", {
        procedure: "kernel32.dll::VirtualAlloc",
      }),
    ).toEqual(CALLERS);
    expect(
      calls
        .filter(({ operation }) => operation === "procedure_callers")
        .map(({ parameters }) => parameters.procedure),
    ).toEqual(["EXTERNAL:0x4d"]);
  });

  it("reports a containment lookup failure instead of the earlier name refusal", async () => {
    expect(
      await call(hopperShaped([]), "procedure_callers", {
        procedure: "containment_timeout",
      }),
    ).toMatchObject({ error: { code: "cancelled" } });
  });
});

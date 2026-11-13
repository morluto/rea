import { expect, it } from "vitest";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { createAnalysisExecution } from "./AnalysisProvider.js";
import { EnhancedTools } from "./EnhancedTools.js";

it.each([
  "procedure_address",
  "address_name",
  "procedure_pseudo_code",
] as const)(
  "stops batch decompilation when %s retains a cleanup owner",
  async (stage) => {
    const failure = new AnalysisCapabilityUnavailableError(
      "fixture",
      stage,
      "child failed",
      {
        cleanup: { reason: "worker is still owned", resources: ["worker"] },
      },
    );
    const lease = new AnalysisCleanupLease(async () => {}, ["worker"]);
    lease.bindCleanupError(failure);
    const addresses = ["0x1000", "0x2000", "0x3000"];
    const calls: string[] = [];
    const result = await new EnhancedTools({
      execute: async (operation, parameters) => {
        const selector = String(parameters.procedure ?? parameters.address);
        calls.push(`${operation}:${selector}`);
        if (
          operation === stage &&
          (stage !== "procedure_pseudo_code" || selector === addresses[1])
        )
          return err(failure);
        return ok(
          createAnalysisExecution(
            operation === "procedure_address"
              ? addresses[["first", "second", "third"].indexOf(selector)]
              : operation === "address_name"
                ? "entry"
                : `code ${selector}`,
            { id: "fixture", name: "Fixture", version: "1" },
          ),
        );
      },
    }).execute("batch_decompile", { addresses: ["first", "second", "third"] });
    if (result.ok)
      throw new Error("Unresolved cleanup was reported as a completed batch");
    expect(result.error).toBe(failure);
    const resolution = ["first", "second", "third"].map(
      (value) => `procedure_address:${value}`,
    );
    const identities = addresses.map((value) => `address_name:${value}`);
    expect(calls).toEqual(
      stage === "procedure_address"
        ? resolution.slice(0, 1)
        : stage === "address_name"
          ? [...resolution, identities[0]]
          : [
              ...resolution,
              ...identities,
              "procedure_pseudo_code:0x1000",
              "procedure_pseudo_code:0x2000",
            ],
    );
    expect(result.error.cleanupResources).toEqual(["worker"]);
    if (stage === "procedure_pseudo_code")
      expect(result).toMatchObject({
        partialResult: {
          total: 1,
          succeeded: 1,
          failed: 0,
          items: [
            { address: "first", status: "ok", pseudocode: "code 0x1000" },
          ],
        },
      });
    await lease.release();
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);

it.each([
  { mode: "provider", admitted: 0 },
  { mode: "provider", admitted: 1 },
  { mode: "signal", admitted: 0 },
  { mode: "signal", admitted: 1 },
])(
  "retains $admitted admitted batch items when $mode cancellation stops a later read",
  async ({ mode, admitted }) => {
    const controller = new AbortController();
    const reason = { requested: "batch stop" };
    const cancelled = new AnalysisCancelledError("procedure_pseudo_code", {
      cause: reason,
    });
    const calls: string[] = [];
    let pseudocodeReads = 0;
    const result = await new EnhancedTools({
      execute: async (operation, parameters) => {
        const selector = String(parameters.procedure ?? parameters.address);
        calls.push(`${operation}:${selector}`);
        if (
          operation === "procedure_pseudo_code" &&
          pseudocodeReads++ === admitted
        ) {
          if (mode === "provider") return err(cancelled);
          controller.abort(reason);
        }
        return ok(
          createAnalysisExecution(
            operation === "procedure_address"
              ? selector
              : operation === "address_name"
                ? "entry"
                : `code ${selector}`,
            { id: "fixture", name: "Fixture", version: "1" },
          ),
        );
      },
    }).execute(
      "batch_decompile",
      { addresses: ["0x1000", "0x2000", "0x3000"] },
      controller.signal,
    );
    if (result.ok) throw new Error("Cancelled batch completed successfully");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    if (mode === "provider") expect(result.error).toBe(cancelled);
    if (admitted === 0) expect(result).not.toHaveProperty("partialResult");
    else
      expect(result).toMatchObject({
        partialResult: {
          total: 1,
          succeeded: 1,
          failed: 0,
          items: [
            { address: "0x1000", pseudocode: "code 0x1000", status: "ok" },
          ],
        },
      });
    expect(
      calls.filter((call) => call.startsWith("procedure_pseudo_code:")),
    ).toEqual([
      "procedure_pseudo_code:0x1000",
      ...(admitted === 0 ? [] : ["procedure_pseudo_code:0x2000"]),
    ]);
  },
);

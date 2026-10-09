import { describe, expect, it } from "vitest";
import { runDirectAnalysis } from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../src/domain/analysisErrorCore.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { err } from "../../src/domain/result.js";
import { observed } from "../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";

const inventory = [
  { address: "0x1000", value: "table_only" },
  { address: "0x1000", value: "entry_alias" },
  { address: "0x1000", value: "namespace::function" },
  { address: "0x2000", value: "data_symbol" },
  { address: "0x3000", value: "unreferenced" },
  { address: "0x1000", value: "same_address" },
  { address: "0x1000", value: "same_address" },
  { address: "0x1000", value: "ambiguous" },
  { address: "0x2000", value: "ambiguous" },
];

const fixture = (
  options: {
    readonly inventoryError?: AnalysisError;
    readonly malformedInventory?: boolean;
    readonly acceptsNamedSelectors?: boolean;
    readonly xrefsError?: AnalysisInputError;
  } = {},
) => {
  let closed = 0;
  const createSession = () =>
    createTestBinarySession(() => ({
      execute: (operation, parameters) => {
        if (operation === "list_names")
          return Promise.resolve(
            options.inventoryError !== undefined
              ? err(options.inventoryError)
              : observed(
                  options.malformedInventory ? "not an inventory" : inventory,
                ),
          );
        if (operation === "procedure_address")
          return Promise.resolve(observed("0x1000"));
        if (operation === "xrefs") {
          if (options.xrefsError !== undefined)
            return Promise.resolve(err(options.xrefsError));
          const address = parameters.address;
          if (
            !options.acceptsNamedSelectors &&
            (typeof address !== "string" ||
              !/^(?:(?:0[xX])?[0-9a-fA-F]+|space%20name:0[xX][0-9a-fA-F]+)$/u.test(
                address,
              ))
          )
            return Promise.resolve(
              err(
                new AnalysisInputError("xrefs", undefined, [
                  { path: ["address"], reason: "invalid_format" },
                ]),
              ),
            );
          return Promise.resolve(
            observed(address === "0x3000" ? [] : ["0x4000"]),
          );
        }
        return Promise.resolve(observed(null));
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    }));
  const dependencies: DirectAnalysisDependencies = {
    createBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  return { dependencies, closed: () => closed };
};

describe("direct CLI cross-reference selectors", () => {
  it("retains validation issues unrelated to symbol resolution", async () => {
    const [path] = await createBinarySessionTargets();
    const issues = [
      { path: ["address"], reason: "invalid_format" },
      { path: ["extra"], reason: "unknown_argument" },
    ] as const;
    const provider = fixture({
      xrefsError: new AnalysisInputError("xrefs", undefined, issues),
    });
    const result = await runDirectAnalysis(
      provider.dependencies,
      path,
      "xrefs",
      { address: "table_only", extra: true },
    );
    expect(result).toMatchObject({
      code: "invalid_request",
      details: { operation: "xrefs", issues },
    });
    expect(provider.closed()).toBe(1);
  });
  it.each(["hidden_alias", "dead"])(
    "retains the provider's existing interpretation of %s",
    async (address) => {
      const [path] = await createBinarySessionTargets();
      const provider = fixture({
        acceptsNamedSelectors: true,
        malformedInventory: true,
      });
      const evidence = parseEvidence(
        await runDirectAnalysis(provider.dependencies, path, "xrefs", {
          address,
        }),
      );
      expect(evidence.parameters).toEqual({ address });
      expect(evidence.normalized_result).toEqual(["0x4000"]);
      expect(provider.closed()).toBe(1);
    },
  );
  it.each([
    "table_only",
    "entry_alias",
    "namespace::function",
    "data_symbol",
    "same_address",
    "0x1000",
    "1000",
    "0X1000",
    "space%20name:0x1000",
  ])(
    "inspects %s and retains the original selector in Evidence",
    async (address) => {
      const [path] = await createBinarySessionTargets();
      const provider = fixture();
      const evidence = parseEvidence(
        await runDirectAnalysis(provider.dependencies, path, "xrefs", {
          address,
        }),
      );
      expect(evidence.parameters).toEqual({ address });
      expect(evidence.normalized_result).toEqual(["0x4000"]);
      expect(provider.closed()).toBe(1);
    },
  );

  it("distinguishes a resolved unreferenced symbol from an unknown name", async () => {
    const [path] = await createBinarySessionTargets();
    const provider = fixture();
    const empty = parseEvidence(
      await runDirectAnalysis(provider.dependencies, path, "xrefs", {
        address: "unreferenced",
      }),
    );
    expect(empty.normalized_result).toEqual([]);
    const missing = await runDirectAnalysis(
      provider.dependencies,
      path,
      "xrefs",
      {
        address: "missing_symbol",
      },
    );
    expect(missing).toMatchObject({
      code: "invalid_request",
      details: { operation: "xrefs", issues: [{ path: ["address"] }] },
    });
    expect(JSON.stringify(missing)).toContain("missing_symbol");
    expect(provider.closed()).toBe(2);
  });

  it("reports every candidate for an ambiguous exact name", async () => {
    const [path] = await createBinarySessionTargets();
    const provider = fixture();
    const result = await runDirectAnalysis(
      provider.dependencies,
      path,
      "xrefs",
      {
        address: "ambiguous",
      },
    );
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(JSON.stringify(result)).toContain("0x1000");
    expect(JSON.stringify(result)).toContain("0x2000");
    expect(provider.closed()).toBe(1);
  });

  it("uses procedure resolution when the provider has no symbol inventory", async () => {
    const [path] = await createBinarySessionTargets();
    const provider = fixture({
      inventoryError: new AnalysisCapabilityUnavailableError(
        "fixture",
        "list_names",
        "only procedure inventory is supported",
      ),
    });
    const evidence = parseEvidence(
      await runDirectAnalysis(provider.dependencies, path, "xrefs", {
        address: "table_only",
      }),
    );
    expect(evidence.parameters).toEqual({ address: "table_only" });
    expect(evidence.normalized_result).toEqual(["0x4000"]);
    expect(provider.closed()).toBe(1);
  });

  it.each([
    {
      options: { inventoryError: new AnalysisCancelledError("list_names") },
      code: "cancelled",
    },
    { options: { malformedInventory: true }, code: "unreadable_output" },
  ])(
    "preserves $code from inventory resolution and releases the session",
    async ({ options, code }) => {
      const [path] = await createBinarySessionTargets();
      const provider = fixture(options);
      const result = await runDirectAnalysis(
        provider.dependencies,
        path,
        "xrefs",
        {
          address: "table_only",
        },
      );
      expect(result).toMatchObject({ code });
      expect(provider.closed()).toBe(1);
    },
  );
});

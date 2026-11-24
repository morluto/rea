import { projectCliAnalysisResult } from "../../src/cli/projectCliAnalysisResult.js";
import { parseConfig } from "../../src/config/parseConfig.js";
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
import { err, ok as resultOk } from "../../src/domain/result.js";
import { observed } from "../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";

const inventory = [
  { address: "0x1000", value: "add" },
  { address: "0x1000", value: "0xHelper" },
  { address: "0x1000", value: "name:0xSuffix" },
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
    readonly requiresPrefixedAddresses?: boolean;
  } = {},
) => {
  let closed = 0;
  const calls: { operation: string; parameters: unknown }[] = [];
  const createSession = () =>
    createTestBinarySession(() => ({
      execute: (operation, parameters) => {
        if (operation !== "health") calls.push({ operation, parameters });
        if (operation === "list_names")
          return Promise.resolve(
            options.inventoryError !== undefined
              ? err(options.inventoryError)
              : observed(
                  options.malformedInventory ? "not an inventory" : inventory,
                ),
          );
        if (operation === "procedure_address")
          return Promise.resolve(
            parameters.procedure === "main"
              ? observed("0x5000")
              : err(
                  new AnalysisInputError(
                    "procedure_address",
                    { conformsToInputContract: true },
                    [{ path: ["procedure"], reason: "invalid_value" }],
                  ),
                ),
          );
        if (operation === "xrefs") {
          if (options.xrefsError !== undefined)
            return Promise.resolve(err(options.xrefsError));
          const address = parameters.address;
          if (
            !options.acceptsNamedSelectors &&
            ((options.requiresPrefixedAddresses &&
              typeof address === "string" &&
              !address.startsWith("0x")) ||
              typeof address !== "string" ||
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
          if (address === "0x5000")
            return Promise.resolve(observed(["0x6000"]));
          return Promise.resolve(
            observed(address === "0x3000" ? [] : ["0x4000"]),
          );
        }
        return Promise.resolve(observed(null));
      },
      close: () => {
        closed += 1;
        return Promise.resolve(resultOk(null));
      },
    }));
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: createSession,
    createArtifactBinarySession: createSession,
    createNativeDispatchBinarySession: createSession,
    createNativeBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  return { dependencies, calls, closed: () => closed };
};

describe("direct CLI cross-reference selectors", () => {
  it("retains provider validation issues unrelated to symbol resolution", async () => {
    const [path] = await createBinarySessionTargets();
    const issues = [
      { path: ["address"], reason: "out_of_range", maximum: 4095 },
    ] as const;
    const provider = fixture({
      xrefsError: new AnalysisInputError("xrefs", undefined, issues),
    });
    const result = await runDirectAnalysis(
      provider.dependencies,
      path,
      "xrefs",
      { address: "0x1000" },
    ).then(projectCliAnalysisResult);
    expect(result).toMatchObject({
      code: "invalid_request",
      details: { operation: "xrefs", issues },
    });
    expect(provider.calls).toEqual([
      { operation: "xrefs", parameters: { address: "0x1000" } },
    ]);
    expect(provider.closed()).toBe(1);
  });
  it.each(["hidden_alias", "dead", "0X1000", "space%20name:0x1000"])(
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
        }).then(projectCliAnalysisResult),
      );
      expect(evidence.parameters).toEqual({ address });
      expect(evidence.normalized_result).toEqual(["0x4000"]);
      expect(provider.calls).toEqual([
        { operation: "xrefs", parameters: { address } },
      ]);
      expect(provider.closed()).toBe(1);
    },
  );
});

describe("direct CLI cross-reference name resolution", () => {
  it.each([
    ["add", "0x1000"],
    ["0xHelper", "0x1000"],
    ["name:0xSuffix", "0x1000"],
    ["namespace::function", "0x1000"],
    ["data_symbol", "0x2000"],
    ["same_address", "0x1000"],
  ])(
    "resolves %s after the provider rejects its address format",
    async (address, resolvedAddress) => {
      const [path] = await createBinarySessionTargets();
      const provider = fixture({ requiresPrefixedAddresses: true });
      const evidence = parseEvidence(
        await runDirectAnalysis(provider.dependencies, path, "xrefs", {
          address,
        }).then(projectCliAnalysisResult),
      );
      expect(evidence.parameters).toEqual({ address });
      expect(evidence.normalized_result).toEqual(["0x4000"]);
      expect(provider.calls).toEqual([
        { operation: "xrefs", parameters: { address } },
        { operation: "list_names", parameters: {} },
        { operation: "xrefs", parameters: { address: resolvedAddress } },
      ]);
      expect(provider.closed()).toBe(1);
    },
  );

  it("distinguishes a resolved unreferenced symbol from an unknown name", async () => {
    const [path] = await createBinarySessionTargets();
    const provider = fixture();
    const empty = parseEvidence(
      await runDirectAnalysis(provider.dependencies, path, "xrefs", {
        address: "unreferenced",
      }).then(projectCliAnalysisResult),
    );
    expect(empty.normalized_result).toEqual([]);
    const missing = await runDirectAnalysis(
      provider.dependencies,
      path,
      "xrefs",
      {
        address: "missing_symbol",
      },
    ).then(projectCliAnalysisResult);
    expect(missing).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: expect.stringContaining("search_procedures or list_names"),
      },
      details: { operation: "xrefs", issues: [{ path: ["address"] }] },
    });
    expect(missing).not.toHaveProperty("recovery");
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
    ).then(projectCliAnalysisResult);
    expect(result).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: expect.stringContaining("Select an exact address"),
      },
    });
    expect(result).not.toHaveProperty("recovery");
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
        address: "main",
      }).then(projectCliAnalysisResult),
    );
    expect(evidence.parameters).toEqual({ address: "main" });
    expect(evidence.normalized_result).toEqual(["0x6000"]);
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
      ).then(projectCliAnalysisResult);
      expect(result).toMatchObject({ code });
      expect(provider.calls.map(({ operation }) => operation)).not.toContain(
        "procedure_address",
      );
      expect(provider.closed()).toBe(1);
    },
  );
});

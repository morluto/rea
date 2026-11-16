import { expect, it } from "vitest";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  listNamesFact,
  listProceduresFact,
  listStringsFact,
  searchProceduresFact,
  searchStringsFact,
} from "../domain/native/nativeOperationFacts.js";
import { ok } from "../domain/result.js";
import { executeFact } from "./AnalysisOperationFacts.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../ports/AnalysisProvider.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

const portReturning = (
  result: JsonValue,
  calls: string[] = [],
): AnalysisOperationPort => ({
  execute: async (operation) => {
    calls.push(operation);
    return ok(createAnalysisExecution(result, provider));
  },
});

const nameRow = { address: "0x1000", value: "main", provider_extra: 7 };
const stringRow = { address: "0x2000", value: "hello", provider_extra: 7 };

it.each([
  [listNamesFact, nameRow],
  [listProceduresFact, nameRow],
  [searchProceduresFact, nameRow],
  [listStringsFact, stringRow],
  [searchStringsFact, stringRow],
] as const)(
  "parses %s once, dropping unknown row fields from the fact but not the execution",
  async (contract, row) => {
    const calls: string[] = [];
    const executed = await executeFact(
      portReturning([row], calls),
      contract,
      {},
    );
    expect(calls).toEqual([contract.operation]);
    if (!executed.ok) throw executed.error;
    expect(executed.value.fact).toEqual([
      { address: row.address, value: row.value },
    ]);
    // Evidence is built from the execution, which keeps the source value.
    expect(executed.value.execution.result).toEqual([row]);
  },
);

it("refuses a malformed result with field diagnostics and the observed execution", async () => {
  const executed = await executeFact(
    portReturning([{ address: 4096, value: "main" }]),
    listNamesFact,
    { limit: 1 },
  );
  expect(executed.ok).toBe(false);
  if (executed.ok) return;
  expect(executed.error).toBeInstanceOf(AnalysisOutputError);
  expect(executed.error).toMatchObject({
    operation: "list_names",
    reason: "Provider returned an invalid name inventory",
    diagnostics: {
      contract_issues: [
        {
          path: [0, "address"],
          code: "invalid_type",
          expected: "string",
          received: "number",
        },
      ],
    },
  });
  expect(executed.error.partialObservation).toMatchObject({
    operation: "list_names",
    parameters: { limit: 1 },
    normalized_result: [{ address: 4096, value: "main" }],
  });
});

it("returns the port's own failure unchanged", async () => {
  const failure = new AnalysisOutputError("list_names", "unavailable");
  const executed = await executeFact(
    { execute: async () => ({ ok: false, error: failure }) },
    listNamesFact,
    {},
  );
  expect(executed).toEqual({ ok: false, error: failure });
});

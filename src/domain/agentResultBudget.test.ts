import { expect, it } from "vitest";

import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "./analysisResourceLimits.js";
import {
  budgetedSummaryBytes,
  failureEnvelopeBytes,
  currentAgentResultBudget,
  type AgentResultBudget,
} from "./agentResultBudget.js";
import type { JsonValue } from "./jsonValue.js";
import { runWithAnalysisOperationSnapshot } from "./analysisOperationSnapshot.js";

it("resolves the runtime override, then the launch seed, then the default", () => {
  expect(currentAgentResultBudget(undefined)).toEqual({
    bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES,
    source: "default",
  });
  const seeded = "8192";
  expect(currentAgentResultBudget(seeded)).toEqual({
    bytes: 8192,
    source: "setting",
  });
  expect(
    runWithAnalysisOperationSnapshot(
      {
        revision: 1,
        overrides: { "delivery.agent_result_budget_bytes": 65_536 },
      },
      () => currentAgentResultBudget(seeded),
    ),
  ).toEqual({ bytes: 65_536, source: "runtime" });
});

it.each([
  "0",
  "abc",
  "1.5",
  String(MINIMUM_AGENT_RESULT_BUDGET_BYTES - 1),
  String(MAXIMUM_AGENT_RESULT_BUDGET_BYTES + 1),
])(
  "leaves delivery unbudgeted for the invalid seed %s rather than defaulting",
  (seed) => {
    expect(currentAgentResultBudget(seed)).toBeUndefined();
  },
);

/**
 * A record whose UTF-8 JSON is exactly `bytes` long. `text` is measured as
 * JSON encodes it: escapes take their escaped width, multibyte characters
 * their UTF-8 width.
 */
const recordOfBytes = (bytes: number, text: string): JsonValue => {
  const base = { normalized_result: { text, padding: "" } };
  const used = Buffer.byteLength(JSON.stringify(base));
  const record = {
    normalized_result: { text, padding: "x".repeat(bytes - used) },
  };
  expect(Buffer.byteLength(JSON.stringify(record))).toBe(bytes);
  return record;
};

const TEXT_VARIANTS = [
  ["ASCII", "plain"],
  ["escaped", '"quoted"\\\n\t\u0001'],
  ["multibyte", "é漢\u{1F600}"],
] as const;

const budgets: readonly AgentResultBudget[] = [
  { bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES, source: "default" },
  { bytes: 8192, source: "runtime" },
];

const decide = (evidence: JsonValue, budget: AgentResultBudget) =>
  budgetedSummaryBytes({
    detail: undefined,
    evidence,
    budget,
    retained: true,
    pageable: true,
  });

it.each(
  budgets.flatMap((budget) =>
    TEXT_VARIANTS.map(
      ([label, text]) => [budget.bytes, label, text, budget] as const,
    ),
  ),
)(
  "delivers %i bytes of %s Evidence complete and summarizes one byte more",
  (bytes, _label, text, budget) => {
    expect(decide(recordOfBytes(bytes, text), budget)).toBeUndefined();
    expect(decide(recordOfBytes(bytes + 1, text), budget)).toBe(bytes + 1);
  },
);

it("gives nested Evidence only the budget its envelope leaves", () => {
  const budget = { bytes: 8192, source: "runtime" } as const;
  const envelopeBytes = 1000;
  const decideNested = (evidence: JsonValue) =>
    budgetedSummaryBytes({
      detail: undefined,
      evidence,
      budget,
      retained: true,
      pageable: true,
      envelopeBytes,
    });
  const fits = budget.bytes - envelopeBytes;
  expect(decideNested(recordOfBytes(fits, "plain"))).toBeUndefined();
  expect(decideNested(recordOfBytes(fits + 1, "plain"))).toBe(fits + 1);
  // The envelope is measured without its partial observation.
  const failure = {
    code: "resource_constraint",
    details: { partial_observation: recordOfBytes(fits + 1, "plain") },
  };
  expect(failureEnvelopeBytes(failure)).toBe(
    Buffer.byteLength(
      JSON.stringify({ ...failure, details: { partial_observation: null } }),
    ),
  );
});

it("summarizes only an omitted detail of retained, pageable, budgeted Evidence", () => {
  const budget = {
    bytes: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
    source: "setting",
  } as const;
  const input = {
    detail: undefined,
    evidence: recordOfBytes(budget.bytes + 1, "plain"),
    budget,
    retained: true,
    pageable: true,
  };
  expect(budgetedSummaryBytes(input)).toBe(budget.bytes + 1);
  for (const missing of ["retained", "pageable"] as const)
    expect(
      budgetedSummaryBytes({ ...input, [missing]: false }),
    ).toBeUndefined();
  expect(budgetedSummaryBytes({ ...input, budget: undefined })).toBeUndefined();
  for (const detail of ["complete", "summary"])
    expect(budgetedSummaryBytes({ ...input, detail })).toBeUndefined();
});

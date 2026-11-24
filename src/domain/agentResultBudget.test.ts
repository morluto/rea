import { expect, it } from "vitest";

import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "./analysisResourceLimits.js";
import { currentAgentResultBudget } from "./agentResultBudget.js";
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

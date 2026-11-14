import { expect, it } from "vitest";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err } from "../domain/result.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

const evidence = createEvidence(
  undefined,
  { id: "fixture", name: "Fixture", version: "1" },
  { operation: "observe", parameters: {}, result: { observed: true } },
);

const primary = () =>
  new AnalysisOutputError(
    "observe",
    "later stage failed",
  ).retainPartialObservation(evidence);

const refusal = (
  fact?: Parameters<AnalysisOutputError["retainPartialObservation"]>[0],
) => {
  const error = new AnalysisOutputError("record_evidence", "ledger refused");
  return fact === undefined ? error : error.retainPartialObservation(fact);
};

const deliver = (recorded: ReturnType<typeof refusal>) => {
  const result = new ToolResultDelivery(1024 * 1024).toPartialErrorToolResult(
    primary(),
    false,
    (_record: Evidence) => err(recorded),
  );
  return (
    result.structuredContent as { error: { details: Record<string, unknown> } }
  ).error.details;
};

it.each([
  [
    "unretained",
    { kind: "unretained-evidence", evidence },
    { kind: "unretained-evidence", evidence },
  ],
  [
    "already retained",
    { kind: "retained-evidence", evidence_id: evidence.evidence_id },
    { kind: "retained-evidence", evidence_id: evidence.evidence_id },
  ],
  [
    "silent about retention",
    undefined,
    { kind: "inline-evidence", retention: "unknown", evidence },
  ],
] as const)(
  "keeps the ledger's refusal with a completed partial observation (%s)",
  (_case, fact, expected) => {
    const details = deliver(refusal(fact));
    expect(details.partial_observation).toEqual(expected);
    // The refusal reason stays visible without repeating the partial record.
    expect(details.retention_error).toMatchObject({
      code: "unreadable_output",
    });
    expect(
      (details.retention_error as { details?: Record<string, unknown> })
        .details,
    ).not.toHaveProperty("partial_observation");
  },
);

it("does not reference a retained record the ledger did not name", () => {
  const details = deliver(
    refusal({ kind: "retained-evidence", evidence_id: "ev_other" }),
  );
  expect(details.partial_observation).toMatchObject({
    kind: "inline-evidence",
    retention: "unknown",
  });
});

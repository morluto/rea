import { unknownTarget } from "../domain/targetIdentity.js";
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err } from "../domain/result.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

const evidence = createEvidence(
  unknownTarget("not-observed"),
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

const trackedInlineObservation = (bodyLength: number) => {
  let reads = 0;
  const evidenceRecord: Record<string, JsonValue> = {
    evidence_id: `ev_${String(bodyLength)}`,
  };
  Object.defineProperty(evidenceRecord, "probe", {
    enumerable: true,
    get() {
      reads += 1;
      return "x".repeat(bodyLength);
    },
  });
  return {
    observation: {
      kind: "inline-evidence",
      retention: "unknown",
      evidence: evidenceRecord,
    } satisfies JsonValue,
    reads: () => reads,
  };
};

describe("error delivery omission worklist", () => {
  it("does not measure omission candidates when the initial error fits", () => {
    const partial = trackedInlineObservation(64);
    const completed = trackedInlineObservation(128);
    const result = new ToolResultDelivery(
      1024 * 1024,
    ).toDetailedErrorToolResult(
      new AnalysisOutputError("observe", "fitting failure"),
      {
        partial_observation: partial.observation,
        completed_observation: completed.observation,
      },
      false,
    );
    expect(result.content).toHaveLength(1);
    expect(partial.reads()).toBe(1);
    expect(completed.reads()).toBe(1);
  });

  it("skips candidate sizing when an oversized error has a single unretained candidate", () => {
    const partial = trackedInlineObservation(4096);
    const result = new ToolResultDelivery(4096).toDetailedErrorToolResult(
      new AnalysisOutputError("observe", "oversized single-candidate failure"),
      { partial_observation: partial.observation },
      false,
    );
    expect(result.content).toHaveLength(1);
    expect(partial.reads()).toBe(1);
    expect(
      (
        result.structuredContent as {
          error: { details: Record<string, unknown> };
        }
      ).error.details,
    ).toMatchObject({
      partial_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unknown",
        evidence_id: "ev_4096",
      },
    });
  });

  it("sizes multiple oversized candidates once and omits the largest first", () => {
    const smaller = trackedInlineObservation(512);
    const larger = trackedInlineObservation(4096);
    const result = new ToolResultDelivery(4096).toDetailedErrorToolResult(
      new AnalysisOutputError("observe", "oversized multi-candidate failure"),
      {
        partial_observation: smaller.observation,
        completed_observation: larger.observation,
      },
      false,
    );
    expect(result.content).toHaveLength(1);
    expect(larger.reads()).toBe(2);
    expect(
      (
        result.structuredContent as {
          error: { details: Record<string, unknown> };
        }
      ).error.details,
    ).toMatchObject({
      partial_observation: {
        kind: "inline-evidence",
        retention: "unknown",
      },
      completed_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unknown",
        evidence_id: "ev_4096",
        source_closure: "not-established",
      },
    });
  });

  it("omits multiple oversized candidates across iterations without re-measuring sizes", () => {
    const first = trackedInlineObservation(1600);
    const second = trackedInlineObservation(1800);
    const result = new ToolResultDelivery(3072).toDetailedErrorToolResult(
      new AnalysisOutputError("observe", "multi-iteration failure"),
      {
        partial_observation: first.observation,
        completed_observation: second.observation,
      },
      false,
    );
    expect(result.content).toHaveLength(1);
    expect(first.reads()).toBe(3);
    expect(second.reads()).toBe(2);
    expect(
      (
        result.structuredContent as {
          error: { details: Record<string, unknown> };
        }
      ).error.details,
    ).toMatchObject({
      partial_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unknown",
        evidence_id: "ev_1600",
      },
      completed_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unknown",
        evidence_id: "ev_1800",
        source_closure: "not-established",
      },
    });
  });
});

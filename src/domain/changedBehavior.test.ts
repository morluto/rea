import { describe, expect, it } from "vitest";

import {
  changedBehaviorResultSchema,
  findChangedBehavior,
  type ChangedBehaviorResult,
} from "./changedBehavior.js";
import { createEvidence, type Evidence } from "./evidence.js";
import type { JsonValue } from "./jsonValue.js";

const source = (digit: string): Evidence =>
  createEvidence(
    {
      path: `/tmp/source-${digit}`,
      sha256: digit.repeat(64),
      format: "file",
    },
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "fixture", parameters: {}, result: { digit } },
  );

const left = source("1");
const right = source("2");

const comparison = (
  operation: "compare_process_captures" | "compare_artifacts",
  result: JsonValue,
  input: { readonly salt?: number; readonly evidenceLinks?: string[] } = {},
): Evidence => {
  const process = operation === "compare_process_captures";
  return createEvidence(
    undefined,
    {
      id: process ? "rea-process" : "rea-artifact-comparison",
      name: process
        ? "REA deterministic process harness"
        : "REA artifact comparison",
      version: operation === "compare_process_captures" ? "3" : "1",
    },
    {
      predicateType: process
        ? "rea.process-comparison"
        : "rea.artifact-comparison",
      operation,
      parameters: {
        ...(process
          ? {
              left_evidence_id: left.evidence_id,
              right_evidence_id: right.evidence_id,
            }
          : {
              left_evidence_ids: [left.evidence_id],
              right_evidence_ids: [right.evidence_id],
            }),
        ...(input.salt === undefined ? {} : { salt: input.salt }),
      },
      result,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: input.evidenceLinks ?? [
        left.evidence_id,
        right.evidence_id,
      ],
    },
  );
};

const processResult = (
  overrides: Partial<{
    status: "unchanged" | "changed" | "unknown" | "truncated";
    terminal: "unchanged" | "changed" | "unknown" | "truncated";
    interaction: "unchanged" | "changed" | "unknown" | "truncated";
    exit: "unchanged" | "changed" | "unknown" | "truncated";
    process: "unchanged" | "changed" | "unknown" | "truncated";
  }> = {},
): JsonValue => ({
  status: overrides.status ?? "unchanged",
  terminal: overrides.terminal ?? "unchanged",
  interaction: overrides.interaction ?? "unchanged",
  exit: overrides.exit ?? "unchanged",
  filesystem: "unchanged",
  process: overrides.process ?? "unchanged",
  first_divergence:
    overrides.status === "changed"
      ? {
          status: "found",
          dimension: "terminal",
          index: 0,
          left_at_ms: 0,
          right_at_ms: 0,
          left: "left",
          right: "right",
        }
      : overrides.status === "truncated" || overrides.status === "unknown"
        ? { status: "unknown", reason: "Incomplete fixture." }
        : { status: "none" },
  limitations: [],
});

const artifactResult = (
  nestedLinks: string[] = [left.evidence_id, right.evidence_id],
): JsonValue => ({
  status: "changed",
  left_manifest_id: `agm_${"3".repeat(64)}`,
  right_manifest_id: `agm_${"4".repeat(64)}`,
  summary: {
    unchanged: 0,
    added: 0,
    removed: 0,
    changed: 1,
    unknown: 0,
  },
  changes: [
    {
      classification: "changed",
      logical_path: "main.js",
      dimensions: ["content"],
      left_occurrence_id: `occ_${"5".repeat(64)}`,
      right_occurrence_id: `occ_${"6".repeat(64)}`,
      left_artifact_id: `art_${"7".repeat(64)}`,
      right_artifact_id: `art_${"8".repeat(64)}`,
      evidence_links: nestedLinks,
    },
  ],
  limitations: [],
});

const expectInvalidSummary = (result: ChangedBehaviorResult): void => {
  expect(
    changedBehaviorResultSchema.safeParse({
      ...result,
      summary: { ...result.summary, observed_changes: 0 },
    }).success,
  ).toBe(false);
};

describe("changed behavior", () => {
  it("accepts process comparison Evidence", () => {
    const result = findChangedBehavior([
      comparison("compare_process_captures", processResult()),
    ]);
    expect(result.behavior_status).toBe("observed_unchanged");
  });

  it("reports interaction and process changes", () => {
    const evidence = comparison(
      "compare_process_captures",
      processResult({
        status: "changed",
        interaction: "changed",
        process: "changed",
      }),
    );

    expect(findChangedBehavior([evidence])).toMatchObject({
      behavior_status: "observed_changed",
      summary: { observed_changes: 2 },
      findings: {
        items: expect.arrayContaining([
          expect.objectContaining({
            dimension: "interaction",
            scope: "runtime",
          }),
          expect.objectContaining({ dimension: "process", scope: "runtime" }),
        ]),
      },
    });
  });

  it("classifies runtime changes as observed and cites both observations", () => {
    const evidence = comparison(
      "compare_process_captures",
      processResult({ status: "changed", terminal: "changed" }),
    );
    const result = findChangedBehavior([evidence]);
    expect(changedBehaviorResultSchema.parse(result)).toMatchObject({
      behavior_status: "observed_changed",
      summary: { observed_changes: 1, static_candidates: 0 },
      findings: { items: expect.any(Array) },
    });
    expectInvalidSummary(result);
    expect(result.findings.items[0]).toMatchObject({
      scope: "runtime",
      dimension: "terminal",
      classification: "observed_change",
      evidence_links: expect.arrayContaining([
        evidence.evidence_id,
        left.evidence_id,
        right.evidence_id,
      ]),
    });
  });

  it("keeps static differences as candidates, never runtime observations", () => {
    const evidence = comparison("compare_artifacts", artifactResult());
    const result = findChangedBehavior([evidence]);
    expect(result).toMatchObject({
      behavior_status: "unknown",
      summary: { observed_changes: 0, static_candidates: 1 },
    });
    expect(result.findings.items[0]).toMatchObject({
      scope: "static_candidate",
      dimension: "artifact:main.js",
      classification: "derived_relationship",
    });
    expect(result.limitations).toContain(
      "Static differences are behavior candidates, not runtime observations.",
    );
  });

  it("lets incomplete runtime evidence dominate observed changes", () => {
    const changed = comparison(
      "compare_process_captures",
      processResult({ status: "changed", terminal: "changed" }),
    );
    const unknown = comparison(
      "compare_process_captures",
      processResult({ status: "unknown", exit: "unknown" }),
    );
    const result = findChangedBehavior([changed, unknown]);
    expect(result).toMatchObject({
      behavior_status: "unknown",
      findings: { items: expect.any(Array) },
    });
    expect(findChangedBehavior([changed, unknown])).toEqual(result);
  });

  it("uses complete inline artifact deltas as static candidates", () => {
    const complete = comparison("compare_artifacts", artifactResult());
    expect(findChangedBehavior([complete]).findings.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "artifact:main.js" }),
      ]),
    );
  });

  it("rejects bundles, duplicate comparisons, and malformed exact results", () => {
    const valid = comparison("compare_process_captures", processResult());
    expect(() => findChangedBehavior([valid, valid])).toThrow(
      /duplicate comparison Evidence/u,
    );
    const bundle = createEvidence(
      undefined,
      { id: "rea-bundle-comparison", name: "Bundle", version: "1" },
      {
        predicateType: "rea.bundle-comparison",
        operation: "compare_bundles",
        parameters: {},
        result: {},
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [left.evidence_id, right.evidence_id],
      },
    );
    expect(() => findChangedBehavior([bundle])).toThrow(
      /requires process, artifact, or function/u,
    );
    const malformed = comparison("compare_process_captures", {
      status: "unchanged",
    });
    expect(() => findChangedBehavior([malformed])).toThrow();
    const contradictory = comparison(
      "compare_process_captures",
      processResult({ status: "unchanged", terminal: "changed" }),
    );
    expect(() => findChangedBehavior([contradictory])).toThrow(
      /contradicts its dimensions/u,
    );
    const danglingNested = comparison(
      "compare_artifacts",
      artifactResult([`ev_${"f".repeat(64)}`, right.evidence_id]),
    );
    expect(() => findChangedBehavior([danglingNested])).toThrow(
      /outside its top-level closure/u,
    );
  });
});

describe("changed behavior aggregation", () => {
  it("keeps all comparisons and their complete evidence closure", () => {
    const comparisons = Array.from({ length: 101 }, (_, comparisonIndex) =>
      comparison(
        "compare_process_captures",
        processResult({ status: "changed", terminal: "changed" }),
        {
          salt: comparisonIndex,
          evidenceLinks: [
            left.evidence_id,
            right.evidence_id,
            ...Array.from(
              { length: 200 },
              (_, linkIndex) =>
                `ev_${(comparisonIndex * 200 + linkIndex + 1)
                  .toString(16)
                  .padStart(64, "0")}`,
            ),
          ],
        },
      ),
    );

    const result = findChangedBehavior(comparisons);

    expect(result.summary.observed_changes).toBe(comparisons.length);
    expect(result.evidence_links).toHaveLength(comparisons.length * 201 + 2);
    expect(result.findings.items[0]?.evidence_links).toHaveLength(203);
  });
});

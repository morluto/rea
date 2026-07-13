import { describe, expect, it } from "vitest";

import {
  changedBehaviorResultSchema,
  findChangedBehavior,
} from "../src/domain/changedBehavior.js";
import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import type { JsonValue } from "../src/domain/jsonValue.js";

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
        ? "rea.process-comparison/v3"
        : "rea.artifact-comparison/v1",
      operation,
      parameters: {},
      result,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
};

const processResult = (
  overrides: Partial<{
    status: "unchanged" | "changed" | "unknown" | "truncated";
    terminal: "unchanged" | "changed" | "unknown" | "truncated";
    exit: "unchanged" | "changed" | "unknown" | "truncated";
  }> = {},
): JsonValue => ({
  status: overrides.status ?? "unchanged",
  terminal: overrides.terminal ?? "unchanged",
  interaction: "unchanged",
  exit: overrides.exit ?? "unchanged",
  filesystem: "unchanged",
  protocol: "unchanged",
  process: "unchanged",
  shim: "unchanged",
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
  pagination: {
    readonly offset?: number;
    readonly next_offset?: number | null;
    readonly total?: number;
  } = {},
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
  changes: {
    items: [
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
    offset: pagination.offset ?? 0,
    limit: 100,
    total: pagination.total ?? 1,
    next_offset: pagination.next_offset ?? null,
  },
  limitations: [],
});

describe("changed behavior", () => {
  it("classifies runtime changes as observed and cites both observations", () => {
    const evidence = comparison(
      "compare_process_captures",
      processResult({ status: "changed", terminal: "changed" }),
    );
    const result = findChangedBehavior([evidence], 0, 100);
    expect(changedBehaviorResultSchema.parse(result)).toMatchObject({
      behavior_status: "observed_changed",
      summary: { observed_changes: 1, static_candidates: 0 },
      findings: { total: 1, next_offset: null },
    });
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
    const result = findChangedBehavior([evidence], 0, 100);
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
    const result = findChangedBehavior([changed, unknown], 0, 1);
    expect(result).toMatchObject({
      behavior_status: "unknown",
      findings: { total: 2, limit: 1, next_offset: 1 },
    });
    expect(findChangedBehavior([changed, unknown], 0, 1)).toEqual(result);
  });

  it("keeps incomplete artifact comparison pagination explicit", () => {
    const paged = comparison(
      "compare_artifacts",
      artifactResult({ next_offset: 1, total: 2 }),
    );
    const result = findChangedBehavior([paged], 0, 100);
    expect(result).toMatchObject({
      behavior_status: "unknown",
      summary: { static_candidates: 1, unresolved: 1 },
      findings: { total: 2 },
    });
    expect(result.limitations).toContain(
      "Artifact comparison reports 1 of 2 changes.",
    );
    const laterPage = comparison(
      "compare_artifacts",
      artifactResult({ offset: 1, next_offset: null, total: 2 }),
    );
    expect(() => findChangedBehavior([laterPage], 0, 100)).toThrow(
      /pagination from offset zero/u,
    );
  });

  it("rejects bundles, duplicate comparisons, and malformed exact results", () => {
    const valid = comparison("compare_process_captures", processResult());
    expect(() => findChangedBehavior([valid, valid], 0, 100)).toThrow(
      /duplicate comparison Evidence/u,
    );
    const bundle = createEvidence(
      undefined,
      { id: "rea-bundle-comparison", name: "Bundle", version: "1" },
      {
        predicateType: "rea.bundle-comparison/v1",
        operation: "compare_bundles",
        parameters: {},
        result: {},
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [left.evidence_id, right.evidence_id],
      },
    );
    expect(() => findChangedBehavior([bundle], 0, 100)).toThrow(
      /requires process, artifact, or function/u,
    );
    const malformed = comparison("compare_process_captures", {
      status: "unchanged",
    });
    expect(() => findChangedBehavior([malformed], 0, 100)).toThrow();
    const contradictory = comparison(
      "compare_process_captures",
      processResult({ status: "unchanged", terminal: "changed" }),
    );
    expect(() => findChangedBehavior([contradictory], 0, 100)).toThrow(
      /contradicts its dimensions/u,
    );
    const danglingNested = comparison(
      "compare_artifacts",
      artifactResult({}, [`ev_${"f".repeat(64)}`, right.evidence_id]),
    );
    expect(() => findChangedBehavior([danglingNested], 0, 100)).toThrow(
      /outside its top-level closure/u,
    );
  });
});

import { describe, expect, it } from "vitest";

import { INVESTIGATION_EXAMPLES } from "../src/contracts/investigationExamples.js";
import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import type { JsonValue } from "../src/domain/jsonValue.js";
import {
  correlateStaticAndRuntime,
  staticRuntimeCorrelationResultSchema,
} from "../src/domain/staticRuntimeCorrelation.js";

const staticComparison =
  INVESTIGATION_EXAMPLES.find_changed_behavior.comparisons[0];
if (staticComparison === undefined)
  throw new Error("Missing static comparison fixture");

const capture = (digit: string): Evidence =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "rea.process-capture/v4",
      operation: "capture_process_scenario",
      parameters: {},
      result: { digit },
      authority: "controlled-replay",
      environment: {
        id: `fixture-${digit}`,
        platform: "test",
        architecture: "test",
        isolation: "process",
      },
    },
  );

const leftCapture = capture("1");
const rightCapture = capture("2");

const processComparison = (
  terminal: "unchanged" | "changed" | "unknown" | "truncated",
): Evidence => {
  const result = {
    status: terminal,
    terminal,
    interaction: terminal === "truncated" ? "truncated" : "unchanged",
    exit: terminal === "truncated" ? "truncated" : "unchanged",
    filesystem: terminal === "truncated" ? "truncated" : "unchanged",
    protocol: terminal === "truncated" ? "truncated" : "unchanged",
    process: terminal === "truncated" ? "truncated" : "unchanged",
    shim: terminal === "truncated" ? "truncated" : "unchanged",
    first_divergence:
      terminal === "changed"
        ? {
            status: "found",
            dimension: "terminal",
            index: 0,
            left_at_ms: 0,
            right_at_ms: 0,
            left: "left",
            right: "right",
          }
        : terminal === "truncated" || terminal === "unknown"
          ? { status: "unknown", reason: "Incomplete fixture." }
          : { status: "none" },
    limitations: terminal === "unknown" ? ["Terminal unavailable."] : [],
  } satisfies JsonValue;
  return createEvidence(
    undefined,
    {
      id: "rea-process",
      name: "REA deterministic process harness",
      version: "3",
    },
    {
      predicateType: "rea.process-comparison/v3",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: leftCapture.evidence_id,
        right_evidence_id: rightCapture.evidence_id,
      },
      result,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [leftCapture.evidence_id, rightCapture.evidence_id],
    },
  );
};

const mapping = (
  runtime: Evidence,
  expected: "cochanged" | "static_only" | "runtime_only" | "both_unchanged",
  dimension: "terminal" | "interaction" | "exit" | "shim" = "terminal",
) => ({
  static_comparisons: [staticComparison],
  runtime_comparisons: [runtime],
  mappings: [
    {
      static: {
        comparison_evidence_id: staticComparison.evidence_id,
        selector: {
          kind: "function" as const,
          dimension: "pseudocode" as const,
        },
      },
      runtime: {
        comparison_evidence_id: runtime.evidence_id,
        dimension,
      },
      side_alignment: "left_to_left" as const,
      hypothesis: {
        statement: "The static edit is associated with terminal behavior.",
        expected_pattern: expected,
      },
    },
  ],
});

describe("static/runtime correlation", () => {
  it("accepts interaction and shim runtime dimensions", () => {
    const runtime = processComparison("unchanged");
    expect(
      correlateStaticAndRuntime(mapping(runtime, "static_only", "interaction")),
    ).toMatchObject({ status: "correlated" });
    expect(
      correlateStaticAndRuntime(mapping(runtime, "static_only", "shim")),
    ).toMatchObject({ status: "correlated" });
  });

  it("keeps consistent cochange as a hypothesis with complete citations", () => {
    const runtime = processComparison("changed");
    const result = correlateStaticAndRuntime(mapping(runtime, "cochanged"));
    expect(staticRuntimeCorrelationResultSchema.parse(result)).toMatchObject({
      status: "correlated",
      summary: { hypotheses: 1, contradictions: 0, unresolved: 0 },
      correlations: {
        total: 1,
        items: [
          {
            observed_pattern: "cochanged",
            classification: "hypothesis",
            side_alignment: "left_to_left",
          },
        ],
      },
    });
    expect(result.correlations.items[0]?.evidence_links).toEqual(
      expect.arrayContaining([
        staticComparison.evidence_id,
        runtime.evidence_id,
        leftCapture.evidence_id,
        rightCapture.evidence_id,
      ]),
    );
    expect(result.limitations.join(" ")).toMatch(
      /does not establish causality/u,
    );
  });

  it("classifies an explicit expectation mismatch as contradiction", () => {
    const result = correlateStaticAndRuntime(
      mapping(processComparison("unchanged"), "cochanged"),
    );
    expect(result).toMatchObject({
      status: "contradicted",
      summary: { hypotheses: 0, contradictions: 1, unresolved: 0 },
      correlations: {
        items: [
          { observed_pattern: "static_only", classification: "contradiction" },
        ],
      },
    });
  });

  it("lets unknown and truncation dominate rather than imply equivalence", () => {
    const unknown = correlateStaticAndRuntime(
      mapping(processComparison("unknown"), "cochanged"),
    );
    const truncated = correlateStaticAndRuntime(
      mapping(processComparison("truncated"), "cochanged"),
    );
    expect(unknown).toMatchObject({
      status: "unknown",
      correlations: { items: [{ classification: "unresolved_branch" }] },
    });
    expect(truncated).toMatchObject({
      status: "truncated",
      correlations: { items: [{ observed_pattern: "truncated" }] },
    });
  });

  it("is order-stable, paginated, and rejects duplicates and absent selectors", () => {
    const runtime = processComparison("changed");
    const base = mapping(runtime, "cochanged");
    const second = {
      ...base.mappings[0],
      runtime: { ...base.mappings[0]!.runtime, dimension: "exit" as const },
      hypothesis: {
        statement: "The edit is associated with exit behavior.",
        expected_pattern: "static_only" as const,
      },
    };
    const forward = correlateStaticAndRuntime({
      ...base,
      mappings: [base.mappings[0], second],
      offset: 0,
      limit: 1,
    });
    const reversed = correlateStaticAndRuntime({
      ...base,
      mappings: [second, base.mappings[0]],
      offset: 0,
      limit: 1,
    });
    expect(reversed).toEqual(forward);
    expect(forward.correlations).toMatchObject({ total: 2, next_offset: 1 });
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [base.mappings[0], base.mappings[0]],
      }),
    ).toThrow(/duplicate mappings/u);
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [
          {
            ...base.mappings[0],
            static: {
              ...base.mappings[0]!.static,
              selector: { kind: "function", dimension: "assembly" },
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      correlateStaticAndRuntime({
        ...base,
        mappings: [
          {
            ...base.mappings[0],
            static: {
              comparison_evidence_id: runtime.evidence_id,
              selector: { kind: "function", dimension: "pseudocode" },
            },
          },
        ],
      }),
    ).toThrow(/absent static comparison/u);
  });

  it("rejects comparison citations that disagree with source parameters", () => {
    const runtime = processComparison("changed");
    const forged = createEvidence(undefined, runtime.provider, {
      predicateType: runtime.predicate_type,
      operation: runtime.operation,
      parameters: {
        left_evidence_id: leftCapture.evidence_id,
        right_evidence_id: staticComparison.evidence_id,
      },
      result: runtime.normalized_result,
      confidence: runtime.confidence,
      authority: runtime.authority,
      evidenceLinks: runtime.evidence_links,
    });
    const input = mapping(forged, "cochanged");
    expect(() => correlateStaticAndRuntime(input)).toThrow(
      /closure disagrees with its source parameters/u,
    );
  });
});

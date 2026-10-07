import { describe, expect, it } from "vitest";

import type { VerifierContract } from "../../../src/domain/conformancePackage.js";
import {
  compareDimension,
  evaluateTrustGate,
  trustGateResultSchema,
} from "../../../src/domain/conformanceTrustGate.js";

const contract: VerifierContract = {
  scenario_id: "s1",
  dimensions: [
    { name: "exit_code", required: true, comparison: "exact" },
    { name: "stdout", required: true, comparison: "semantic" },
    { name: "timing", required: true, comparison: "fuzzy" },
  ],
  timing_tolerance_ms: 100,
};

const expectDivergenceRejected = (
  result: ReturnType<typeof evaluateTrustGate>,
): void => {
  expect(
    trustGateResultSchema.safeParse({
      ...result,
      first_divergence: {
        dimension: "exit_code",
        evidence_id: "invented",
        message: "invented",
      },
    }).success,
  ).toBe(false);
};

describe("conformance trust gates", () => {
  it("keeps semantic unknown and truncated values out of equivalence", () => {
    expect(
      compareDimension(
        "process_tree",
        { processes: [] },
        { status: "unknown" },
      ),
    ).toMatchObject({ status: "unknown" });
    expect(
      compareDimension("process_tree", { processes: [] }, { truncated: true }),
    ).toMatchObject({ status: "truncated" });
    expect(
      compareDimension(
        "process_tree",
        { status: "unknown" },
        { status: "unknown" },
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it("projects Evidence envelopes and links a divergence to the observed ID", () => {
    const expectedEvidenceId = `ev_${"1".repeat(64)}`;
    const actualEvidenceId = `ev_${"2".repeat(64)}`;
    const result = evaluateTrustGate(
      contract,
      {
        evidence_id: expectedEvidenceId,
        normalized_result: { exit_code: 0, stdout: "hello" },
      },
      {
        evidence_id: actualEvidenceId,
        normalized_result: { exit_code: 1, stdout: "hello" },
      },
    );
    expect(result.verdict).toBe("fail");
    expect(result.dimension_results[0]?.evidence_ids).toEqual([
      actualEvidenceId,
      expectedEvidenceId,
    ]);
    expect(result.first_divergence).toMatchObject({
      dimension: "exit_code",
      evidence_id: actualEvidenceId,
    });
  });

  it("scopes process residual unknowns without hiding complete dimensions", () => {
    const processContract: VerifierContract = {
      ...contract,
      dimensions: [
        { name: "exit_code", required: true, comparison: "exact" },
        { name: "process_tree", required: true, comparison: "semantic" },
      ],
    };
    const result = evaluateTrustGate(
      processContract,
      { exit_code: 0, process_tree: { processes: [] } },
      {
        exit_code: 0,
        process_tree: { processes: [] },
        residual_unknowns: [{ scope: "process", reason: "event gap" }],
      },
    );
    expect(result.verdict).toBe("unknown");
    expect(result.dimension_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "exit_code", status: "match" }),
        expect.objectContaining({ name: "process_tree", status: "unknown" }),
      ]),
    );
  });

  it("passes when all dimensions match", () => {
    const result = evaluateTrustGate(
      contract,
      { exit_code: 0, stdout: "hello" },
      { exit_code: 0, stdout: "hello" },
    );
    expect(result.verdict).toBe("pass");
    expectDivergenceRejected(result);
  });

  it("fails when a required dimension mismatches", () => {
    const result = evaluateTrustGate(
      contract,
      { exit_code: 0, stdout: "hello" },
      { exit_code: 1, stdout: "hello" },
    );
    expect(result.verdict).toBe("fail");
    expect(result.first_divergence).toMatchObject({ dimension: "exit_code" });
  });

  it("reports unknown when both dimensions are undefined", () => {
    const result = evaluateTrustGate(contract, {}, {});
    // exit_code and stdout are both undefined -> unknown
    // timing is volatile -> match
    expect(result.verdict).toBe("unknown");
  });

  it("ignores volatile dimension differences", () => {
    const result = evaluateTrustGate(
      contract,
      { exit_code: 0, stdout: "hello", timing: 100 },
      { exit_code: 0, stdout: "hello", timing: 200 },
    );
    expect(result.verdict).toBe("pass");
  });

  it("truncated evidence is not treated as equivalence", () => {
    const result = evaluateTrustGate(
      contract,
      { exit_code: 0, stdout: "hello" },
      { exit_code: 0, stdout: "hello" },
      { truncated: true },
    );
    expect(result.verdict).toBe("fail");
  });
});

describe("conformance structured JSON comparison", () => {
  it.each([
    ['{"__proto__":{"version":1}}', '{"__proto__":{"version":2}}'],
    ['{"__proto__":"before"}', '{"__proto__":"after"}'],
    ["{}", '{"__proto__":null}'],
    [
      '{"entries":[{"payload":{"__proto__":{"version":1}}}]}',
      '{"entries":[{"payload":{"__proto__":{"version":2}}}]}',
    ],
    ['{"constructor":1}', '{"constructor":2}'],
    ['{"prototype":1}', '{"prototype":2}'],
  ])("preserves changed own JSON keys in %s", (before, after) => {
    const expected: unknown = JSON.parse(before);
    const actual: unknown = JSON.parse(after);

    expect(compareDimension("filesystem", expected, actual)).toMatchObject({
      status: "mismatch",
    });
    expect(JSON.stringify(expected)).toBe(before);
    expect(JSON.stringify(actual)).toBe(after);
  });

  it("ignores key order while preserving own JSON keys in nested objects", () => {
    const expected: unknown = JSON.parse(
      '{"__proto__":{"a":1,"b":2},"constructor":[{"x":1,"prototype":2}]}',
    );
    const actual: unknown = JSON.parse(
      '{"constructor":[{"prototype":2,"x":1}],"__proto__":{"b":2,"a":1}}',
    );

    expect(compareDimension("filesystem", expected, actual)).toMatchObject({
      status: "match",
    });
  });
});

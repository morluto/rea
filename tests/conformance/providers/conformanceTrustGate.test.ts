import { describe, expect, it } from "vitest";

import type { VerifierContract } from "../../../src/domain/conformancePackage.js";
import {
  compareDimension,
  evaluateTrustGate,
  isSemanticDimension,
  isVolatileDimension,
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

describe("conformance trust gates", () => {
  it("classifies volatile dimensions correctly", () => {
    expect(isVolatileDimension("timing")).toBe(true);
    expect(isVolatileDimension("timestamp")).toBe(true);
    expect(isVolatileDimension("pid")).toBe(true);
    expect(isVolatileDimension("exit_code")).toBe(false);
  });

  it("classifies semantic dimensions correctly", () => {
    expect(isSemanticDimension("exit_code")).toBe(true);
    expect(isSemanticDimension("stdout")).toBe(true);
    expect(isSemanticDimension("timing")).toBe(false);
  });

  it("matches identical values", () => {
    const result = compareDimension("exit_code", 0, 0);
    expect(result.status).toBe("match");
  });

  it("detects mismatches", () => {
    const result = compareDimension("exit_code", 0, 1);
    expect(result.status).toBe("mismatch");
  });

  it("ignores volatile dimensions", () => {
    const result = compareDimension("timing", 100, 200);
    expect(result.status).toBe("match");
    expect(result.message).toContain("volatile");
  });

  it("handles truncated evidence", () => {
    const result = compareDimension("exit_code", 0, null, {
      truncated: true,
    });
    expect(result.status).toBe("truncated");
  });

  it("handles undefined values", () => {
    const result = compareDimension("exit_code", undefined, undefined);
    expect(result.status).toBe("unknown");
  });

  it("handles missing actual", () => {
    const result = compareDimension("exit_code", 0, undefined);
    expect(result.status).toBe("unknown");
  });

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
  });

  it("fails when a required dimension mismatches", () => {
    const result = evaluateTrustGate(
      contract,
      { exit_code: 0, stdout: "hello" },
      { exit_code: 1, stdout: "hello" },
    );
    expect(result.verdict).toBe("fail");
    expect(result.first_divergence).not.toBeNull();
    expect(result.first_divergence!.dimension).toBe("exit_code");
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

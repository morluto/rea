import { describe, expect, it } from "vitest";

import {
  createConformancePackage,
  type ConformancePackageInput,
} from "../../../src/domain/conformancePackage.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  packageReplayResultSchema,
  replayConformancePackage,
  type ScenarioReplayResult,
} from "../../../src/domain/conformanceReplay.js";

const validPackageInput: ConformancePackageInput = {
  name: "test-fixture",
  description: "A test conformance fixture",
  created_at: "2026-07-28T00:00:00Z",
  scenarios: [
    {
      scenario_id: "s1",
      name: "Simple spawn",
      description: "A simple process spawn scenario",
      fixture_path: "tests/conformance/c/fixture.c",
      expected_exit_code: 0,
      expected_patterns: [],
    },
  ],
  replay_plans: [
    {
      scenario_id: "s1",
      steps: [
        {
          step_id: "step1",
          action: "run",
          arguments: [],
          timeout_ms: 1000,
        },
      ],
      environment: {},
    },
  ],
  shim_plans: [],
  expected_evidence: [
    {
      scenario_id: "s1",
      envelopes: [],
      bundle: null,
      required_dimensions: [],
    },
  ],
  verifier_contracts: [
    {
      scenario_id: "s1",
      dimensions: [{ name: "exit_code", required: true, comparison: "exact" }],
      timing_tolerance_ms: 0,
    },
  ],
};

const validPackage = createConformancePackage(validPackageInput);

async function passingRunner(
  scenarioId: string,
): Promise<ScenarioReplayResult> {
  return {
    scenario_id: scenarioId,
    status: "pass",
    exit_code: 0,
    duration_ms: 10,
    output: "ok",
    error: null,
  };
}

async function failingRunner(
  scenarioId: string,
): Promise<ScenarioReplayResult> {
  return {
    scenario_id: scenarioId,
    status: "fail",
    exit_code: 1,
    duration_ms: 10,
    output: "fail",
    error: null,
  };
}

describe("conformance CI replay", () => {
  it("replays a package with passing scenarios", async () => {
    const result = await replayConformancePackage(
      validPackage,
      {},
      passingRunner,
    );
    expect(result.total_scenarios).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.drift_detected).toBe(false);
    expect(
      packageReplayResultSchema.safeParse({ ...result, drift_detected: true })
        .success,
    ).toBe(false);
    expect(
      packageReplayResultSchema.safeParse({ ...result, passed: 0 }).success,
    ).toBe(false);
  });

  it("replays a package with failing scenarios", async () => {
    const result = await replayConformancePackage(
      validPackage,
      {},
      failingRunner,
    );
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);
  });

  it("retains the observed Evidence ID on the first drift", async () => {
    const expected = createEvidence(
      undefined,
      { id: "fixture-provider", name: "Fixture provider", version: "1" },
      { operation: "run", parameters: {}, result: { exit_code: 0 } },
    );
    const pkg = createConformancePackage({
      ...validPackageInput,
      expected_evidence: [
        {
          scenario_id: "s1",
          envelopes: [expected],
          bundle: null,
          required_dimensions: ["exit_code"],
        },
      ],
    });
    const actualEvidenceId = `ev_${"3".repeat(64)}`;
    const result = await replayConformancePackage(
      pkg,
      {
        s1: {
          evidence_id: actualEvidenceId,
          normalized_result: { exit_code: 1 },
        },
      },
      passingRunner,
    );
    expect(result.drift_detected).toBe(true);
    expect(result.first_drift).toMatchObject({
      dimension: "exit_code",
      evidence_id: actualEvidenceId,
    });
  });

  it("throws on invalid package", async () => {
    await expect(replayConformancePackage({}, {})).rejects.toThrow(
      /invalid conformance package/u,
    );
  });

  it("counts pass, fail, error and skipped results without losing runner diagnostics", async () => {
    const cases = [
      { id: "s1", status: "pass" },
      { id: "s2", status: "fail" },
      { id: "s3", status: "error" },
      { id: "s4", status: "skipped" },
    ] as const;
    const multiPackage = createConformancePackage({
      ...validPackageInput,
      scenarios: cases.flatMap(({ id }) =>
        validPackage.scenarios.map((scenario) => ({
          ...scenario,
          scenario_id: id,
        })),
      ),
      replay_plans: cases.flatMap(({ id }) =>
        validPackage.replay_plans.map((plan) => ({ ...plan, scenario_id: id })),
      ),
      expected_evidence: cases.flatMap(({ id }) =>
        validPackage.expected_evidence.map((evidence) => ({
          ...evidence,
          scenario_id: id,
        })),
      ),
      verifier_contracts: cases.flatMap(({ id }) =>
        validPackage.verifier_contracts.map((contract) => ({
          ...contract,
          scenario_id: id,
        })),
      ),
    });
    const result = await replayConformancePackage(
      multiPackage,
      {},
      async (scenarioId) => {
        const item = cases.find(({ id }) => id === scenarioId);
        if (item === undefined)
          throw new Error(`Unexpected scenario: ${scenarioId}`);
        return {
          scenario_id: scenarioId,
          status: item.status,
          exit_code:
            item.status === "pass" ? 0 : item.status === "fail" ? 1 : null,
          duration_ms: 10,
          output: "",
          error:
            item.status === "error"
              ? "fixture runner failed"
              : item.status === "skipped"
                ? "fixture prerequisite unavailable"
                : null,
        };
      },
    );
    expect(result).toMatchObject({
      total_scenarios: cases.length,
      passed: 1,
      failed: 1,
      errored: 1,
      skipped: 1,
    });
    expect(result.scenario_results).toEqual(
      cases.map(({ id, status }) => ({
        scenario_id: id,
        status,
        exit_code: status === "pass" ? 0 : status === "fail" ? 1 : null,
        duration_ms: 10,
        output: "",
        error:
          status === "error"
            ? "fixture runner failed"
            : status === "skipped"
              ? "fixture prerequisite unavailable"
              : null,
      })),
    );
  });
});

describe("conformance replay package boundary", () => {
  it("rejects shape-valid packages with broken scenario relations", async () => {
    await expect(
      replayConformancePackage(
        {
          ...validPackage,
          replay_plans: [
            {
              scenario_id: "missing",
              steps: [
                {
                  step_id: "step1",
                  action: "run",
                  arguments: [],
                  timeout_ms: 1000,
                },
              ],
              environment: {},
            },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/replay_plans references unknown scenario missing/u);
  });
});

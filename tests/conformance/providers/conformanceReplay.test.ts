import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_PACKAGE_VERSION,
  createConformancePackage,
  type ConformancePackageInput,
} from "../../../src/domain/conformancePackage.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  replayConformancePackage,
  type ScenarioReplayResult,
} from "../../../src/domain/conformanceReplay.js";

const validPackageInput: ConformancePackageInput = {
  schema_version: CONFORMANCE_PACKAGE_VERSION,
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

  it("does not detect drift when expected and actual match", async () => {
    const result = await replayConformancePackage(
      validPackage,
      {},
      passingRunner,
    );
    expect(result.drift_detected).toBe(false);
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

  it("counts all result types", async () => {
    const multiPackage = createConformancePackage({
      ...validPackageInput,
      scenarios: [
        ...validPackage.scenarios,
        {
          scenario_id: "s2",
          name: "Second scenario",
          description: "Second",
          fixture_path: "tests/conformance/c/fixture2.c",
          expected_exit_code: 1,
          expected_patterns: [],
        },
      ],
      replay_plans: [
        ...validPackage.replay_plans,
        {
          scenario_id: "s2",
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
      expected_evidence: [
        ...validPackage.expected_evidence,
        {
          scenario_id: "s2",
          envelopes: [],
          bundle: null,
          required_dimensions: [],
        },
      ],
      verifier_contracts: [
        ...validPackage.verifier_contracts,
        {
          scenario_id: "s2",
          dimensions: [
            { name: "exit_code", required: true, comparison: "exact" },
          ],
          timing_tolerance_ms: 0,
        },
      ],
    });
    const result = await replayConformancePackage(
      multiPackage,
      {},
      async (scenarioId) => ({
        scenario_id: scenarioId,
        status: scenarioId === "s1" ? "pass" : "fail",
        exit_code: scenarioId === "s1" ? 0 : 1,
        duration_ms: 10,
        output: "",
        error: null,
      }),
    );
    expect(result.total_scenarios).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
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

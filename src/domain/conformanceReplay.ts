import { z } from "zod";

import { parseConformancePackage } from "./conformancePackage.js";
import {
  evaluatePackageTrustGates,
  trustGateResultSchema,
} from "./conformanceTrustGate.js";

/** Result of a single scenario replay. */
export const scenarioReplayResultSchema = z.strictObject({
  scenario_id: z.string().min(1),
  status: z.enum(["pass", "fail", "error", "skipped"]),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative(),
  output: z.string().default(""),
  error: z.string().nullable(),
});

/** Result of replaying an entire conformance package. */
export const packageReplayResultSchema = z
  .strictObject({
    package_id: z.string().min(1),
    total_scenarios: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    scenario_results: z.array(scenarioReplayResultSchema),
    trust_gate_results: z.array(trustGateResultSchema),
    drift_detected: z.boolean(),
    first_drift: z
      .strictObject({
        scenario_id: z.string().min(1),
        dimension: z.string().min(1),
        evidence_id: z.string().min(1),
        message: z.string(),
      })
      .nullable(),
  })
  .superRefine((result, context) => {
    const count = (status: ScenarioReplayResult["status"]): number =>
      result.scenario_results.filter((item) => item.status === status).length;
    const countMismatch =
      result.passed !== count("pass") ||
      result.failed !== count("fail") ||
      result.errored !== count("error") ||
      result.skipped !== count("skipped");
    const driftDetected = result.trust_gate_results.some(
      ({ verdict }) => verdict === "fail",
    );
    if (
      result.total_scenarios !== result.scenario_results.length ||
      countMismatch
    )
      context.addIssue({
        code: "custom",
        message: "Scenario totals must summarize scenario results",
        path: ["total_scenarios"],
      });
    if (result.drift_detected !== driftDetected)
      context.addIssue({
        code: "custom",
        message: "Drift status must summarize trust-gate failures",
        path: ["drift_detected"],
      });
    if (!driftDetected && result.first_drift !== null)
      context.addIssue({
        code: "custom",
        message: "A drift witness requires a failed trust gate",
        path: ["first_drift"],
      });
  });

export type ScenarioReplayResult = z.infer<typeof scenarioReplayResultSchema>;
export type PackageReplayResult = z.infer<typeof packageReplayResultSchema>;

/** Callback interface for replaying a scenario. */
export interface ScenarioRunner {
  (scenarioId: string, fixturePath: string): Promise<ScenarioReplayResult>;
}

/**
 * Default no-op scenario runner that skips all scenarios.
 * Real CI replays inject an actual runner.
 */
async function defaultRunner(): Promise<ScenarioReplayResult> {
  return {
    scenario_id: "unknown",
    status: "skipped",
    exit_code: null,
    duration_ms: 0,
    output: "",
    error: "no runner provided",
  };
}

/**
 * Replay a conformance package from a clean checkout.
 * Runs each scenario, evaluates trust gates, and detects drift
 * between the captured run and the committed package.
 */
export async function replayConformancePackage(
  packageInput: unknown,
  actualEvidence: Record<string, Record<string, unknown>>,
  runner: ScenarioRunner = defaultRunner,
  options: { truncated?: boolean } = {},
): Promise<PackageReplayResult> {
  const parsed = parseConformancePackage(packageInput);
  if (!parsed.ok)
    throw new TypeError(`invalid conformance package: ${parsed.error.message}`);
  const pkg = parsed.value;

  const scenarioResults: ScenarioReplayResult[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let skipped = 0;

  for (const scenario of pkg.scenarios) {
    const result = await runner(scenario.scenario_id, scenario.fixture_path);
    scenarioResults.push(result);

    switch (result.status) {
      case "pass":
        passed++;
        break;
      case "fail":
        failed++;
        break;
      case "error":
        errored++;
        break;
      case "skipped":
        skipped++;
        break;
    }
  }

  const trustGateResults = evaluatePackageTrustGates(
    pkg,
    actualEvidence,
    options,
  );

  const driftGates = trustGateResults.filter((r) => r.verdict === "fail");
  const drift_detected = driftGates.length > 0;
  const first_drift_gate = driftGates[0];
  const first_drift = first_drift_gate?.first_divergence
    ? {
        scenario_id: first_drift_gate.scenario_id,
        dimension: first_drift_gate.first_divergence.dimension,
        evidence_id: first_drift_gate.first_divergence.evidence_id,
        message: first_drift_gate.first_divergence.message,
      }
    : null;

  return packageReplayResultSchema.parse({
    package_id: pkg.package_id,
    total_scenarios: pkg.scenarios.length,
    passed,
    failed,
    errored,
    skipped,
    scenario_results: scenarioResults,
    trust_gate_results: trustGateResults,
    drift_detected,
    first_drift,
  });
}

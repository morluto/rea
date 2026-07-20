import { describe, expect, it } from "vitest";

import {
  runPairedProcessExperiment,
  type ProcessCapturePort,
} from "../src/application/ProcessPairedExperiment.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import { parseProcessCapture } from "../src/domain/processCapture.js";
import {
  analyzeProcessRepeatability,
  bindProcessScenario,
  processPairedExperimentSchema,
} from "../src/domain/processPairedExperiment.js";
import { ok } from "../src/domain/result.js";

const experiment = () =>
  processPairedExperimentSchema.parse({
    approved: true,
    shared_scenario: {
      approved: true,
      executable: "/bin/template",
      arguments: ["shared"],
      working_directory: "/tmp",
      environment: { SHARED: "yes" },
    },
    authority: {
      id: "authority",
      executable: "/bin/authority",
      environment: { SIDE: "authority" },
    },
    candidate: {
      id: "candidate",
      executable: "/bin/candidate",
      arguments: ["candidate"],
      environment: { SIDE: "candidate" },
    },
    repeat_count: 3,
    freshness_policy: { max_capture_age_ms: 60_000 },
    required_dimensions: ["terminal", "exit", "protocol"],
    reconstruction_claims: [],
  });

const policy = {
  enabled: true,
  executableRoots: ["/bin"],
  workingRoots: ["/tmp"],
  allowedEnvironment: ["SHARED", "SIDE"],
  allowExternalNetwork: false,
};

describe("paired process experiments", () => {
  it("binds only declared side inputs onto the shared observation contract", () => {
    const parsed = experiment();
    const authority = bindProcessScenario(
      parsed.shared_scenario,
      parsed.authority,
    );
    const candidate = bindProcessScenario(
      parsed.shared_scenario,
      parsed.candidate,
    );
    expect(authority).toMatchObject({
      executable: "/bin/authority",
      arguments: ["shared"],
      environment: { SHARED: "yes", SIDE: "authority" },
    });
    expect(candidate).toMatchObject({
      executable: "/bin/candidate",
      arguments: ["candidate"],
      environment: { SHARED: "yes", SIDE: "candidate" },
    });
  });

  it("runs same-side comparisons first and compares stable sides", async () => {
    const observedExecutables: string[] = [];
    const capture = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
    const capturePort: ProcessCapturePort = {
      capture: (scenario) => {
        observedExecutables.push(scenario.executable);
        return Promise.resolve(ok(structuredClone(capture)));
      },
    };
    const result = await runPairedProcessExperiment(experiment(), policy, {
      capturePort,
      now: () => Date.parse("2026-01-01T00:00:01.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(observedExecutables).toEqual([
      "/bin/authority",
      "/bin/authority",
      "/bin/authority",
      "/bin/candidate",
      "/bin/candidate",
      "/bin/candidate",
    ]);
    expect(result.value.authority_repeatability.stable).toBe(true);
    expect(result.value.candidate_repeatability.stable).toBe(true);
    expect(result.value.cross_side?.status).toBe("unchanged");
  });

  it("blocks cross-side claims when a candidate has a flaky exit", async () => {
    const base = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
    let candidateRun = 0;
    const capturePort: ProcessCapturePort = {
      capture: (scenario) => {
        let capture = structuredClone(base);
        if (scenario.executable === "/bin/candidate") {
          candidateRun += 1;
          if (candidateRun === 2)
            capture = {
              ...capture,
              exit: { code: 1, signal: null, reason: "exited" },
            };
        }
        return Promise.resolve(ok(capture));
      },
    };
    const result = await runPairedProcessExperiment(experiment(), policy, {
      capturePort,
      now: () => Date.parse("2026-01-01T00:00:01.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidate_repeatability).toMatchObject({
      stable: false,
      classification: "flaky_exit",
      unstable_dimensions: ["exit"],
    });
    expect(result.value.cross_side).toBeNull();
    expect(result.value.cross_side_blocked_reason).toMatch(/unstable/u);
  });

  it("distinguishes normalized timing variance from semantic output drift", () => {
    const base = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
    const early = {
      ...base,
      frames: [{ sequence: 0, at_ms: 10, data: "ready" }],
    };
    const late = {
      ...base,
      frames: [{ sequence: 0, at_ms: 20, data: "ready" }],
    };
    expect(
      analyzeProcessRepeatability([early, late], ["terminal"]),
    ).toMatchObject({
      stable: false,
      classification: "timing_variance",
      unstable_dimensions: ["terminal"],
    });
    const changed = {
      ...base,
      frames: [{ sequence: 0, at_ms: 20, data: "failed" }],
    };
    expect(
      analyzeProcessRepeatability([early, changed], ["terminal"]),
    ).toMatchObject({ classification: "nondeterministic_output" });
  });
});

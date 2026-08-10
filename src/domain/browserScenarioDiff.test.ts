import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compareBrowserScenarios,
  compareBrowserScenariosInputSchema,
} from "./browserScenarioDiff.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "./browserScenarioCapture.js";

describe("browser scenario comparison", () => {
  it("records canonical literal normalization and ignores declared volatile fields", () => {
    const before = scenarioCapture({
      domText: "<main data-build='build-123'>Settings</main>",
      elapsedMs: 11,
      eventSequence: 3,
    });
    const after = scenarioCapture({
      domText: "<main data-build='build-456'>Settings</main>",
      elapsedMs: 900,
      eventSequence: 88,
    });
    const rules = [
      {
        rule_id: "new-build",
        artifacts: ["dom"] as const,
        match: "build-456",
        replacement: "[BUILD]",
      },
      {
        rule_id: "old-build",
        artifacts: ["dom"] as const,
        match: "build-123",
        replacement: "[BUILD]",
      },
    ];

    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
        normalization: { rules },
      }),
    );
    const reordered = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
        normalization: {
          rules: [...rules].reverse().map((rule) => ({
            ...rule,
            artifacts: [...rule.artifacts].reverse(),
          })),
        },
      }),
    );

    expect(compared.overall_status).toBe("unchanged");
    expect(compared.alignment.status).toBe("aligned");
    expect(compared.artifact_diffs.total).toBe(0);
    expect(compared.normalization).toMatchObject({
      rules: [
        { rule_id: "new-build", artifacts: ["dom"] },
        { rule_id: "old-build", artifacts: ["dom"] },
      ],
    });
    expect(reordered.normalization.sha256).toBe(compared.normalization.sha256);
  });

  it("exposes action mismatches and normalized artifact-level changes", () => {
    const before = scenarioCapture({
      domText: "<main>Settings</main>",
    });
    const after = scenarioCapture({
      action: "dblclick",
      domText: "<main>Advanced settings</main>",
    });

    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );
    const step = compared.steps.find(
      ({ step_id: stepId }) => stepId === "open-settings",
    );

    expect(compared.overall_status).toBe("changed");
    expect(compared.alignment).toMatchObject({
      status: "partial",
      failures: [
        expect.objectContaining({
          code: "action_mismatch",
          step_id: "open-settings",
        }),
      ],
    });
    expect(step).toMatchObject({
      status: "changed",
      artifact_diffs: [
        expect.objectContaining({
          artifact: "action_state",
          status: "changed",
        }),
        expect.objectContaining({ artifact: "dom", status: "changed" }),
      ],
    });
    expect(compared.artifact_diffs).toEqual({
      total: 2,
      retained: 2,
      omitted: 0,
    });
  });
});

describe("browser scenario comparison validation", () => {
  it("reports missing aligned steps without claiming equality", () => {
    const before = scenarioCapture({});
    const after = scenarioCapture({ stepId: "open-profile" });

    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );

    expect(compared.overall_status).toBe("unknown");
    expect(compared.alignment).toMatchObject({
      status: "partial",
      aligned_steps: 1,
      before_only: ["open-settings"],
      after_only: ["open-profile"],
      failures: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_before_step",
          step_id: "open-profile",
        }),
        expect.objectContaining({
          code: "missing_after_step",
          step_id: "open-settings",
        }),
      ]),
    });
  });

  it("rejects ambiguous input pairs and duplicate normalization rule IDs", () => {
    const capture = scenarioCapture({});
    expect(
      compareBrowserScenariosInputSchema.safeParse({
        before_scenario: capture,
        after_scenario: capture,
        normalization: {
          rules: [
            {
              rule_id: "volatile",
              artifacts: ["dom"],
              match: "one",
              replacement: "[VALUE]",
            },
            {
              rule_id: "volatile",
              artifacts: ["url"],
              match: "two",
              replacement: "[VALUE]",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

interface ScenarioCaptureOptions {
  readonly stepId?: string;
  readonly action?: string;
  readonly domText?: string;
  readonly elapsedMs?: number;
  readonly eventSequence?: number;
}

const scenarioCapture = (
  options: ScenarioCaptureOptions,
): BrowserScenarioCapture => {
  const url = {
    url: "https://app.example.test/settings",
    origin: "https://app.example.test",
    query_parameter_names: [],
    redacted: false,
  };
  const completeness = {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
  const artifacts = (text: string) => ({
    screenshot: { state: "not_requested" },
    dom: { state: "captured", value: textArtifact(text) },
    accessibility: { state: "not_requested" },
    url: { state: "captured", value: url },
    history: { state: "not_requested" },
    storage: { state: "not_requested" },
  });
  const eventSequence = options.eventSequence ?? 1;
  return browserScenarioCaptureSchema.parse({
    schema_version: 1,
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "149.0",
    },
    scenario: {
      start_origin: "https://app.example.test",
      allowed_origins: ["https://app.example.test"],
      action_count: 1,
      secret_references: [],
    },
    duration_ms: options.elapsedMs ?? 10,
    steps: [
      {
        step_index: 0,
        step_id: "scenario_start",
        action: "scenario_start",
        status: "completed",
        elapsed_ms: 0,
        before_url: url,
        after_url: url,
        error: null,
        event_sequence_start: 1,
        event_sequence_end: 0,
        artifacts: artifacts("<main>Ready</main>"),
        completeness,
      },
      {
        step_index: 1,
        step_id: options.stepId ?? "open-settings",
        action: options.action ?? "click",
        status: "completed",
        elapsed_ms: options.elapsedMs ?? 10,
        before_url: url,
        after_url: url,
        error: null,
        event_sequence_start: eventSequence,
        event_sequence_end: eventSequence,
        artifacts: artifacts(options.domText ?? "<main>Settings</main>"),
        completeness,
      },
    ],
    events: {
      retained: 1,
      dropped: 0,
      items: [
        {
          sequence: eventSequence,
          step_index: 1,
          kind: "console",
          level: "info",
          text: "settings-ready",
          url: null,
        },
      ],
    },
    completeness,
    limitations: [],
  });
};

const textArtifact = (text: string) => {
  const bytes = Buffer.from(text);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    text,
  };
};

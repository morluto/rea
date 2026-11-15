import { AnalysisInputError } from "./analysisErrorCore.js";
import { expect, it } from "vitest";

import { createEvidenceBundle } from "./evidenceBundle.js";
import { jsonObjectSchema, jsonValueSchema } from "./jsonValue.js";
import { verifyReconstruction } from "./reconstructionVerification.js";
import {
  reconstructionSpecificationSchema,
  type ReconstructionClaim,
} from "./reconstructionVerificationSchemas.js";
import { createResidualUnknown } from "./residualUnknown.js";
import {
  webVerificationCapture,
  webVerificationCaptureComparison,
  webVerificationImage,
  webVerificationMutation,
  webVerificationScenario,
  webVerificationScreenshotComparison,
} from "./reconstructionWebVerification.fixture.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { classifyBrowserCompleteness } from "./browserCompleteness.js";
import { comparePngScreenshots } from "./pngVisualDiff.js";
import {
  WEB_COMPARISON_PROVIDER,
  readWebScenarioSource,
} from "./webComparisonSources.js";
import { browserScenarioSchema } from "./browserScenario.js";
import { digestCanonicalValue } from "./canonicalDigest.js";

const scenarioClaim = (
  comparison: Evidence,
  changes: Partial<Extract<ReconstructionClaim, { kind: "web-scenario" }>> = {},
) => ({
  claim_id: "settings-dom",
  title: "Settings renders the same content",
  kind: "web-scenario",
  dimension: "dom",
  step_id: "wait",
  comparison_evidence_id: comparison.evidence_id,
  ...changes,
});
const pixelClaim = (comparison: Evidence, maximum = 0) => ({
  claim_id: "settings-pixels",
  title: "Settings satisfies the selected visual tolerance",
  kind: "web-screenshot",
  dimension: "pixels",
  maximum_changed_ratio: maximum,
  comparison_evidence_id: comparison.evidence_id,
});
const verify = (claims: unknown[], records: Evidence[]) =>
  verifyReconstruction(
    { name: "Settings reconstruction", claims },
    createEvidenceBundle(records),
  );

it("keeps incomplete equality unknown while failing an independently observed DOM difference", () => {
  const left = webVerificationScenario();
  for (const changed of [false, true]) {
    const right = webVerificationScenario({
      duration: 2,
      incomplete: true,
      ...(changed ? { dom: "<main>Different</main>" } : {}),
    });
    const comparison = webVerificationCaptureComparison(left, right);
    const result = verify(
      [scenarioClaim(comparison)],
      [left, right, comparison],
    );
    expect(result.status).toBe(changed ? "fail" : "unknown");
    expect(result.claims.items[0]?.limitations).toContainEqual(
      expect.stringContaining("incomplete"),
    );
  }
});

it("does not accept an incomplete screenshot merely because a visual tolerance admits its difference", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    duration: 2,
    incomplete: true,
    screenshot: webVerificationImage(10),
  });
  const comparison = webVerificationScreenshotComparison(left, right);
  expect(
    verify([pixelClaim(comparison, 0)], [left, right, comparison]).status,
  ).toBe("fail");
  expect(
    verify([pixelClaim(comparison, 1)], [left, right, comparison]).status,
  ).toBe("unknown");
});

it("uses the screenshot coverage ledger even when an imported headline says complete", () => {
  const artifact = webVerificationImage();
  const complete = classifyBrowserCompleteness({
    policyFilteredSections: new Set(),
    attachLimitedSections: new Set(),
    truncatedSections: new Set(),
    unavailableSections: new Set(),
    excluded: [],
    droppedEvents: {
      scripts: 0,
      network_requests: 0,
      console_events: 0,
      websocket_connections: 0,
      websocket_frames: 0,
      webmcp_tools: 0,
      timeline_events: 0,
    },
  });
  const source = (second: number, coverage: typeof complete) =>
    createEvidence(
      undefined,
      { id: "fixture-cdp", name: "Fixture CDP", version: "1" },
      {
        operation: "capture_web_screenshot",
        predicateType: "rea.web-screenshot",
        parameters: { target_id: "page" },
        result: {
          browser: {
            product: "Chromium",
            protocol_version: "1.3",
            revision: "same",
            user_agent: "fixture",
            js_version: "fixture",
          },
          target: {
            target_id: "page",
            origin: "https://example.test",
            url: "https://example.test/",
          },
          captured_at: `2026-11-15T00:00:0${second}.000Z`,
          viewport: { width: 2, height: 1 },
          artifact,
          completeness: coverage,
          limitations: [],
        },
        confidence: "observed",
        authority: "external-service",
        environment: null,
      },
    );
  const left = source(1, complete);
  for (const coverage of [
    complete,
    { ...complete, truncated_sections: ["screenshot" as const] },
    { ...complete, unavailable_sections: ["screenshot" as const] },
    {
      ...complete,
      excluded: [
        {
          section: "screenshot" as const,
          reason: "resource_budget_exhausted" as const,
          count: 1,
        },
      ],
    },
  ]) {
    const right = source(2, coverage);
    const comparison = createEvidence(undefined, WEB_COMPARISON_PROVIDER, {
      operation: "compare_web_screenshots",
      predicateType: "rea.web-screenshot-diff",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        channel_threshold: 0,
      },
      result: comparePngScreenshots({
        before: artifact,
        after: artifact,
        channel_threshold: 0,
      }),
      confidence: "derived",
      authority: "analyst-inference",
      environment: null,
      evidenceLinks: [left.evidence_id, right.evidence_id].sort(),
    });
    expect(
      verify([pixelClaim(comparison)], [left, right, comparison]).status,
    ).toBe(coverage === complete ? "pass" : "unknown");
  }
});

it("verifies independent cross-origin scenario observations only with committed origin correspondence", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    origin: "http://localhost:4173",
    duration: 2,
  });
  const unmapped = webVerificationCaptureComparison(left, right);
  expect(
    verify([scenarioClaim(unmapped)], [left, right, unmapped]),
  ).toMatchObject({
    status: "unknown",
    summary: { behavioral: 1, structural: 0 },
    recommended_probes: [{ operation: "capture_browser_scenario" }],
  });
  const mapped = webVerificationCaptureComparison(left, right, {
    origin_mapping: {
      before_origin: "https://original.example.test",
      after_origin: "http://localhost:4173",
    },
  });
  expect(
    verify(
      [scenarioClaim(mapped, { dimension: "url" })],
      [left, right, mapped],
    ),
  ).toMatchObject({
    status: "pass",
    claims: { items: [{ step_id: "wait", observed_status: "unchanged" }] },
  });
});

it("does not turn visual agreement into agreement on the scenario's content", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    duration: 2,
    dom: "<main>Wrong settings</main>",
  });
  const compared = webVerificationCaptureComparison(left, right);
  const pixels = webVerificationScreenshotComparison(left, right);
  expect(
    verify(
      [scenarioClaim(compared), pixelClaim(pixels)],
      [left, right, compared, pixels],
    ),
  ).toMatchObject({
    status: "fail",
    summary: { passed: 1, failed: 1, behavioral: 1, structural: 1 },
    claims: {
      items: [
        { claim_id: "settings-dom", status: "fail" },
        { claim_id: "settings-pixels", status: "pass" },
      ],
    },
  });
});

it("keeps per-channel comparison tolerance separate from maximum accepted changed-pixel proportion", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    duration: 2,
    screenshot: webVerificationImage(10),
  });
  const pixels = webVerificationScreenshotComparison(left, right);
  expect(
    verify([pixelClaim(pixels, 0.5)], [left, right, pixels]),
  ).toMatchObject({
    status: "pass",
    claims: {
      items: [
        {
          observed_status: "changed",
          measured_changed_ratio: 0.5,
          maximum_changed_ratio: 0.5,
        },
      ],
    },
  });
  expect(verify([pixelClaim(pixels, 0.49)], [left, right, pixels]).status).toBe(
    "fail",
  );
  const thresholded = webVerificationScreenshotComparison(left, right, 10);
  expect(
    verify([pixelClaim(thresholded)], [left, right, thresholded]),
  ).toMatchObject({
    status: "pass",
    claims: { items: [{ measured_changed_ratio: 0 }] },
  });
});

it("keeps absent, incomplete and dimension-incompatible image observations unknown", () => {
  const left = webVerificationScenario();
  for (const options of [
    { duration: 2, screenshot: null },
    { duration: 2, incomplete: true },
    { duration: 2, screenshot: webVerificationImage(0, 1) },
  ]) {
    const right = webVerificationScenario(options);
    const pixels = webVerificationScreenshotComparison(left, right);
    expect(verify([pixelClaim(pixels, 1)], [left, right, pixels]).status).toBe(
      "unknown",
    );
  }
  const right = webVerificationScenario({ duration: 2, screenshot: null });
  const compared = webVerificationCaptureComparison(left, right);
  expect(
    verify(
      [scenarioClaim(compared, { dimension: "screenshot" })],
      [left, right, compared],
    ).status,
  ).toBe("unknown");
});

it("requires captured artifacts and exact step selections even when no differences were reported", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({ duration: 2 });
  const compared = webVerificationCaptureComparison(left, right);
  for (const changes of [
    { dimension: "history" as const },
    { step_id: "not-recorded" },
  ])
    expect(
      verify([scenarioClaim(compared, changes)], [left, right, compared])
        .status,
    ).toBe("unknown");
  const output = verify(
    [
      scenarioClaim(compared, {
        claim_id: "initial",
        step_id: "scenario_start",
      }),
      scenarioClaim(compared),
    ],
    [left, right, compared],
  );
  expect(output.summary.passed).toBe(2);
  expect(
    reconstructionSpecificationSchema.safeParse({
      name: "duplicate",
      claims: [
        scenarioClaim(compared),
        scenarioClaim(compared, { claim_id: "duplicate" }),
      ],
    }).success,
  ).toBe(false);
});

it("withholds verification for shared observations, incompatible environments and weak source authority", () => {
  const left = webVerificationScenario();
  const shared = webVerificationCaptureComparison(left, left);
  expect(verify([scenarioClaim(shared)], [left, shared]).status).toBe(
    "unknown",
  );
  const weak = webVerificationMutation(
    webVerificationScenario({ duration: 2 }),
    { confidence: "inferred" },
  );
  const changedEnvironment = webVerificationScenario({
    duration: 2,
    width: 800,
  });
  for (const right of [weak, changedEnvironment]) {
    const compared = webVerificationCaptureComparison(left, right);
    expect(
      verify([scenarioClaim(compared)], [left, right, compared]).status,
    ).toBe("unknown");
  }
});

it("rejects altered derivations and source closures even when their replacement Evidence ids are valid", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    duration: 2,
    dom: "<main>Changed</main>",
  });
  const compared = webVerificationCaptureComparison(left, right);
  const forged = webVerificationMutation(compared, {
    normalized_result: {
      ...jsonObjectSchema.parse(compared.normalized_result),
      overall_status: "unchanged",
    },
  });
  expect(() => verify([scenarioClaim(forged)], [left, right, forged])).toThrow(
    /committed source Evidence/,
  );
  const extra = webVerificationScenario({ duration: 3 });
  const badClosure = webVerificationMutation(compared, {
    evidence_links: [left.evidence_id, right.evidence_id, extra.evidence_id],
  });
  expect(() =>
    verify([scenarioClaim(badClosure)], [left, right, extra, badClosure]),
  ).toThrow(/closure/);
  expect(() => verify([scenarioClaim(compared)], [left, compared])).toThrow(
    AnalysisInputError,
  );
  const tampered = {
    ...right,
    normalized_result: jsonValueSchema.parse({
      ...webVerificationCapture(right),
      duration_ms: 99,
    }),
  };
  expect(() =>
    verify([scenarioClaim(compared)], [left, tampered, compared]),
  ).toThrow();
});

it("recomputes screenshot metrics and refuses a falsely lowered ratio with a valid Evidence identity", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({
    duration: 2,
    screenshot: webVerificationImage(10),
  });
  const pixels = webVerificationScreenshotComparison(left, right);
  const forged = webVerificationMutation(pixels, {
    normalized_result: {
      ...jsonObjectSchema.parse(pixels.normalized_result),
      changed_ratio: 0.01,
    },
  });
  expect(() =>
    verify([pixelClaim(forged, 0.1)], [left, right, forged]),
  ).toThrow(/committed source Evidence/);
});

it("preserves active unknowns for otherwise passing visual claims", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({ duration: 2 });
  const pixels = webVerificationScreenshotComparison(left, right);
  const mutation = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "record_unknown",
      predicateType: "rea.residual-unknown-mutation",
      parameters: {},
      result: { action: "record" },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [pixels.evidence_id],
    },
  );
  const unknown = createResidualUnknown(
    {
      question: "Was the selected screen stable?",
      severity: "medium",
      domain: "web",
      supporting_evidence_ids: [pixels.evidence_id],
      contradicting_evidence_ids: [],
      required_authority: "controlled-replay",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    },
    mutation.evidence_id,
    null,
  );
  const bundle = createEvidenceBundle(
    [left, right, pixels, mutation],
    [unknown],
  );
  expect(
    verifyReconstruction(
      {
        name: "Visual with unresolved stability",
        claims: [pixelClaim(pixels)],
      },
      bundle,
    ).status,
  ).toBe("unknown");
});

it("rejects a request/capture step binding change instead of attributing it to another scenario", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({ duration: 2 });
  const capture = webVerificationCapture(right);
  const changed = structuredClone(capture);
  const step = changed.steps[1];
  if (step === undefined) throw new Error("Missing fixture step");
  step.step_id = "different-step";
  const rebound = webVerificationMutation(right, {
    normalized_result: jsonValueSchema.parse(changed),
  });
  expect(() => webVerificationCaptureComparison(left, rebound)).toThrow(
    /captured steps/,
  );
  const hashMismatch = webVerificationMutation(right, {
    parameters: { ...right.parameters, scenario_sha256: "0".repeat(64) },
  });
  expect(() => webVerificationCaptureComparison(left, hashMismatch)).toThrow(
    /committed identity/,
  );
});

it("selects each step and dimension independently when many claims share one authenticated comparison", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({ duration: 2 });
  const capture = structuredClone(webVerificationCapture(right));
  const step = capture.steps[1];
  if (step === undefined) throw new Error("Missing fixture step");
  step.artifacts.dom = { state: "not_requested" };
  const partial = webVerificationMutation(right, {
    normalized_result: jsonValueSchema.parse(capture),
  });
  const compared = webVerificationCaptureComparison(left, partial);
  const result = verify(
    [
      scenarioClaim(compared, {
        claim_id: "initial-dom",
        step_id: "scenario_start",
      }),
      scenarioClaim(compared, { claim_id: "wait-dom" }),
      scenarioClaim(compared, { claim_id: "wait-url", dimension: "url" }),
      scenarioClaim(compared, { claim_id: "all-dom", step_id: undefined }),
    ],
    [left, partial, compared],
  );
  expect(
    result.claims.items.map(({ claim_id, status }) => ({ claim_id, status })),
  ).toEqual([
    { claim_id: "all-dom", status: "unknown" },
    { claim_id: "initial-dom", status: "pass" },
    { claim_id: "wait-dom", status: "unknown" },
    { claim_id: "wait-url", status: "pass" },
  ]);
  expect(() =>
    verify(
      [
        scenarioClaim(compared),
        {
          kind: "web-capture",
          claim_id: "wrong-kind",
          title: "A passive capture",
          dimension: "overall",
          comparison_evidence_id: compared.evidence_id,
        },
      ],
      [left, partial, compared],
    ),
  ).toThrow(/observation types/);
});

it("rejects an imported screenshot comparison with a committed but incorrect origin mapping", () => {
  const left = webVerificationScenario();
  const right = webVerificationScenario({ duration: 2 });
  const pixels = webVerificationScreenshotComparison(left, right);
  const wrong = webVerificationMutation(pixels, {
    parameters: {
      ...pixels.parameters,
      origin_mapping: {
        before_origin: "https://unrelated.example.test",
        after_origin: "https://original.example.test",
      },
    },
  });
  expect(() => verify([pixelClaim(wrong)], [left, right, wrong])).toThrow(
    /selected observation origins/,
  );
});

it("withholds experiment equality for used secret inputs, while unused declarations do not imply unknown values were used", () => {
  const withSecret = (source: Evidence, used: boolean) => {
    const { scenario, capture } = readWebScenarioSource(source);
    const request = browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        {
          secret_id: "form-password",
          environment_variable: "REA_TEST_PASSWORD",
        },
      ],
      actions: used
        ? [
            {
              step_id: "wait",
              action: "fill",
              locator: { kind: "test_id", value: "password" },
              value: { source: "secret", secret_id: "form-password" },
            },
          ]
        : scenario.actions,
    });
    const result = structuredClone(capture);
    result.scenario.secret_references = used ? ["form-password"] : [];
    const step = result.steps[1];
    if (step === undefined) throw new Error("Missing fixture step");
    if (used) step.action = "fill";
    return webVerificationMutation(source, {
      parameters: {
        ...jsonObjectSchema.parse(request),
        scenario_sha256: digestCanonicalValue(request, "Browser scenario"),
      },
      normalized_result: jsonValueSchema.parse(result),
    });
  };
  for (const used of [true, false]) {
    const left = withSecret(webVerificationScenario(), used);
    const right = withSecret(webVerificationScenario({ duration: 2 }), used);
    const compared = webVerificationCaptureComparison(left, right);
    const pixels = webVerificationScreenshotComparison(left, right);
    expect(
      verify(
        [scenarioClaim(compared), pixelClaim(pixels)],
        [left, right, compared, pixels],
      ).status,
    ).toBe(used ? "unknown" : "pass");
  }
});

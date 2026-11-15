import { z } from "zod";
import { immutableEvidence, type Evidence } from "./evidence.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import {
  browserScenarioSchema,
  browserScenarioSecretReferences,
  type BrowserScenario,
} from "./browserScenario.js";
import {
  retainedBrowserScenarioCaptureSchema,
  type RetainedBrowserScenarioCapture,
} from "./browserScenarioCapture.js";
import { webPageInspectionSchema } from "./browserObservationSchemas.js";
import {
  webScreenshotSchema,
  webScreenshotDiffSchema,
  type WebScreenshotArtifact,
} from "./webScreenshot.js";
import { compareBrowserScenariosInputSchema } from "./browserScenarioDiffValues.js";
import {
  browserCaptureComparisonInputSchema,
  type BrowserCaptureComparisonInput,
} from "./browserCaptureComparison.js";
import { mapBrowserScenarioUrl } from "./browserScenarioOriginMapping.js";
import { sanitizeBrowserUrl } from "./browserObservation.js";
import type { BrowserScenarioOriginMapping } from "./browserScenarioDiffValues.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import type { JsonValue } from "./jsonValue.js";
import { incompleteBrowserSections } from "./browserCompleteness.js";

/** Identity of the offline, Evidence-bound comparison producer. */
export const WEB_COMPARISON_PROVIDER = {
  id: "rea-web-comparison",
  name: "REA web comparison",
  version: "1",
} as const;

/** Identity of the dedicated web-comparison derivation, independent from other comparison readers. */
export const hasWebComparisonEvidenceIdentity = (source: Evidence): boolean => {
  const expectedPredicate =
    source.operation === "compare_web_captures"
      ? "rea.web-capture-diff"
      : source.operation === "compare_web_screenshots"
        ? "rea.web-screenshot-diff"
        : undefined;
  return (
    expectedPredicate !== undefined &&
    source.predicate_type === expectedPredicate &&
    source.provider.id === WEB_COMPARISON_PROVIDER.id &&
    source.provider.name === WEB_COMPARISON_PROVIDER.name &&
    source.provider.version === WEB_COMPARISON_PROVIDER.version &&
    source.confidence === "derived" &&
    source.authority === "analyst-inference" &&
    source.subject === null
  );
};

/** Absent captured pixels are unknown, never a fabricated image or dimension mismatch. */
export const webScreenshotComparisonResultSchema = z.union([
  webScreenshotDiffSchema,
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
    limitations: z.array(z.string()),
  }),
]);

export const webCaptureComparisonPolicySchema = z.object({
  normalization: compareBrowserScenariosInputSchema.shape.normalization,
  origin_mapping: compareBrowserScenariosInputSchema.shape.origin_mapping,
});
export type WebCaptureComparisonPolicy = z.output<
  typeof webCaptureComparisonPolicySchema
>;

/** A correspondence must name the selected observations, never a guessed origin. */
export const validateWebComparisonOriginMapping = (
  left: Evidence,
  right: Evidence,
  mapping?: BrowserScenarioOriginMapping,
): void => {
  if (mapping === undefined) return;
  const origin = (source: Evidence) =>
    source.operation === "capture_browser_scenario"
      ? readWebScenarioSource(source).capture.scenario.start_origin
      : source.operation === "capture_web_screenshot"
        ? webScreenshotSchema.parse(source.normalized_result).target.origin
        : undefined;
  if (
    origin(left) !== mapping.before_origin ||
    origin(right) !== mapping.after_origin
  )
    throw new TypeError(
      "Origin mapping must match both selected observation origins.",
    );
};

/** Validate a source once at the owning boundary; raw payloads are never observations. */
export const readWebComparisonSource = (input: Evidence): Evidence => {
  const source = immutableEvidence(input);
  const predicates: Readonly<Record<string, string>> = {
    capture_browser_scenario: "rea.browser-scenario-capture",
    capture_web_screenshot: "rea.web-screenshot",
    inspect_web_page: "rea.web-page-inspection",
  };
  if (
    predicates[source.operation] === undefined ||
    source.predicate_type !== predicates[source.operation]
  )
    throw new TypeError(
      "Expected browser scenario, screenshot or page inspection Evidence.",
    );
  if (
    source.operation === "capture_web_screenshot" ||
    source.operation === "inspect_web_page"
  ) {
    const observation =
      source.operation === "capture_web_screenshot"
        ? webScreenshotSchema.parse(source.normalized_result)
        : webPageInspectionSchema.parse(source.normalized_result);
    if (source.parameters.target_id !== observation.target.target_id)
      throw new TypeError(
        "Browser observation target and request identity disagree.",
      );
  }
  return source;
};

/** Validate the scenario's retained request and its binding to the observation. */
const scenarioFacts = new WeakMap<
  Evidence,
  {
    readonly scenario: BrowserScenario;
    readonly capture: RetainedBrowserScenarioCapture;
  }
>();
export const readWebScenarioSource = (input: Evidence) => {
  const source = immutableEvidence(input);
  const retained = scenarioFacts.get(source);
  if (retained !== undefined) return retained;
  if (source.operation !== "capture_browser_scenario")
    throw new TypeError("Expected capture_browser_scenario Evidence.");
  const { scenario_sha256, ...request } = source.parameters;
  const scenario = browserScenarioSchema.parse(request);
  if (scenario_sha256 !== digestCanonicalValue(scenario, "Browser scenario"))
    throw new TypeError(
      "Browser scenario parameters do not match their committed identity.",
    );
  const capture = retainedBrowserScenarioCaptureSchema.parse(
    source.normalized_result,
  );
  if (
    new URL(scenario.start_url.url).origin !== capture.scenario.start_origin ||
    scenario.actions.length !== capture.scenario.action_count
  )
    throw new TypeError(
      "Browser scenario request and capture identity disagree.",
    );
  for (const [index, action] of scenario.actions.entries()) {
    const step = capture.steps[index + 1];
    if (step?.step_id !== action.step_id || step.action !== action.action)
      throw new TypeError(
        "Browser scenario request and captured steps disagree.",
      );
  }
  const facts = { scenario, capture };
  // Both schemas read authenticated JSON. Optional keys are absent rather than
  // undefined; seal these owner-parsed facts before sharing them with consumers.
  freezeJsonSnapshot(facts as JsonValue);
  scenarioFacts.set(source, facts);
  return facts;
};

/** Resolve compatible observations into the existing pure capture comparator's input. */
export const webCaptureSourceInput = (
  left: Evidence,
  right: Evidence,
  policy: WebCaptureComparisonPolicy,
): BrowserCaptureComparisonInput => {
  if (left.operation !== right.operation)
    throw new TypeError(
      "Web comparison sources must have the same observation type.",
    );
  if (left.operation === "capture_browser_scenario")
    return compareBrowserScenariosInputSchema.parse({
      before_scenario: readWebScenarioSource(left).capture,
      after_scenario: readWebScenarioSource(right).capture,
      ...policy,
    });
  if (left.operation !== "inspect_web_page")
    throw new TypeError(
      "Capture comparison requires scenario or page inspection Evidence.",
    );
  if (
    policy.origin_mapping !== undefined ||
    policy.normalization.rules.length > 0
  )
    throw new TypeError(
      "Origin mapping and normalization require browser scenario Evidence.",
    );
  return browserCaptureComparisonInputSchema.parse({
    before: {
      inspection: webPageInspectionSchema.parse(left.normalized_result),
    },
    after: {
      inspection: webPageInspectionSchema.parse(right.normalized_result),
    },
  });
};

/** Select one actual captured PNG; a missing/ambiguous selector cannot become an image. */
export const webScreenshotSourceArtifact = (
  source: Evidence,
  stepId?: string,
): WebScreenshotArtifact | undefined => {
  if (source.operation === "capture_web_screenshot") {
    if (stepId !== undefined)
      throw new TypeError("step_id applies only to browser scenario Evidence.");
    return webScreenshotSchema.parse(source.normalized_result).artifact;
  }
  const { capture } = readWebScenarioSource(source);
  const steps = capture.steps.filter((step) => step.step_id === stepId);
  const screenshot =
    steps.length === 1 ? steps[0]?.artifacts.screenshot : undefined;
  if (stepId === undefined || steps.length !== 1)
    throw new TypeError("Select one exact step_id on each source.");
  return screenshot?.state === "captured" ? screenshot.value : undefined;
};

const completeScenario = (capture: RetainedBrowserScenarioCapture): boolean =>
  capture.completeness.equality_eligible &&
  capture.steps.every(
    (step) =>
      step.status === "completed" && step.completeness.equality_eligible,
  );

/** Authority/context constraints used by verification, independently of apparent equality. */
export const webComparisonSourceAssessment = (
  left: Evidence,
  right: Evidence,
  stepId?: string,
  originMapping?: BrowserScenarioOriginMapping,
): { limitations: string[]; coverage: string[] } => {
  validateWebComparisonOriginMapping(left, right, originMapping);
  const reasons: string[] = [];
  const coverage: string[] = [];
  if (left.evidence_id === right.evidence_id)
    reasons.push(
      "Independent original and reconstruction observations are unavailable.",
    );
  for (const source of [left, right]) {
    const required =
      source.operation === "capture_browser_scenario"
        ? "controlled-replay"
        : "external-service";
    if (source.confidence !== "observed" || source.authority !== required)
      reasons.push(
        `Source Evidence lacks qualifying observed ${required} authority.`,
      );
  }
  if (left.operation !== right.operation)
    return {
      limitations: [...reasons, "Web source observation types differ."],
      coverage,
    };
  if (left.operation === "capture_browser_scenario") {
    const before = readWebScenarioSource(left);
    const after = readWebScenarioSource(right);
    if (
      browserScenarioSecretReferences(before.scenario).length > 0 ||
      browserScenarioSecretReferences(after.scenario).length > 0
    )
      reasons.push(
        "Resolved secret input values are not retained; equality of the declared experiments is unknown.",
      );
    if (!completeScenario(before.capture) || !completeScenario(after.capture))
      coverage.push(
        "Browser scenario observations are incomplete or contain unsuccessful steps.",
      );
    if (
      digestCanonicalValue(
        before.scenario.environment,
        "Browser environment",
      ) !==
      digestCanonicalValue(after.scenario.environment, "Browser environment")
    )
      reasons.push("Browser scenario environments differ.");
    if (
      digestCanonicalValue(
        scenarioExperiment(before.scenario),
        "Browser experiment",
      ) !==
      digestCanonicalValue(
        scenarioExperiment(after.scenario, originMapping),
        "Browser experiment",
      )
    )
      reasons.push(
        "Browser scenario actions, initial state or capture selections differ.",
      );
    if (
      before.capture.browser.product !== after.capture.browser.product ||
      before.capture.browser.version !== after.capture.browser.version
    )
      reasons.push("Browser product or version differs.");
    if (stepId !== undefined) {
      webScreenshotSourceArtifact(left, stepId);
      webScreenshotSourceArtifact(right, stepId);
    }
  } else if (left.operation === "capture_web_screenshot") {
    const before = webScreenshotSchema.parse(left.normalized_result);
    const after = webScreenshotSchema.parse(right.normalized_result);
    if (
      before.completeness.status !== "complete_within_window" ||
      after.completeness.status !== "complete_within_window" ||
      incompleteBrowserSections(before.completeness).has("screenshot") ||
      incompleteBrowserSections(after.completeness).has("screenshot")
    )
      coverage.push("Screenshot source coverage is incomplete.");
    if (
      digestCanonicalValue(before.browser, "Browser identity") !==
        digestCanonicalValue(after.browser, "Browser identity") ||
      JSON.stringify(before.viewport) !== JSON.stringify(after.viewport)
    )
      reasons.push("Screenshot browser or viewport context differs.");
  }
  return { limitations: reasons, coverage };
};

/** Compare declared experiments independently from executable paths and CDP endpoints. */
const scenarioExperiment = (
  scenario: BrowserScenario,
  mapping?: BrowserScenarioOriginMapping,
) => {
  const destination = (value: BrowserScenario["start_url"]) => ({
    ...value,
    url:
      mapping === undefined
        ? value.url
        : mapBrowserScenarioUrl(sanitizeBrowserUrl(value.url), mapping).url,
  });
  const storageOrigin = (origin: string) =>
    origin === mapping?.after_origin ? mapping.before_origin : origin;
  return {
    environment: scenario.environment,
    start_url: destination(scenario.start_url),
    actions: scenario.actions.map((action) =>
      action.action === "goto"
        ? { ...action, destination: destination(action.destination) }
        : action,
    ),
    storage: {
      cookies: scenario.storage.cookies.map((cookie) => ({
        ...cookie,
        destination: destination(cookie.destination),
      })),
      local_storage: scenario.storage.local_storage.map((storage) => ({
        ...storage,
        origin: storageOrigin(storage.origin),
      })),
      session_storage: scenario.storage.session_storage.map((storage) => ({
        ...storage,
        origin: storageOrigin(storage.origin),
      })),
    },
    capture: scenario.capture,
    // Secret values are deliberately absent; equal references do not establish equal values.
    secret_ids: scenario.secrets.map((secret) => secret.secret_id).sort(),
  };
};

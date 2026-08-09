import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import type {
  BrowserScenario,
  BrowserScenarioAction,
} from "../domain/browserScenario.js";
import {
  browserScenarioCaptureSchema,
  browserScenarioCompletenessSchema,
  browserScenarioStepSchema,
  browserStepArtifactsSchema,
  type BrowserScenarioCapture,
  type BrowserScenarioCompleteness,
  type BrowserScenarioStep,
  type BrowserStepArtifacts,
} from "../domain/browserScenarioCapture.js";
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  BrowserScenarioSessionFactory,
  BrowserScenarioSessionPort,
} from "./BrowserScenarioSessionPort.js";
import { BrowserScenarioCaptureBudget } from "./PlaywrightScenarioArtifacts.js";

const OPERATION = "capture_browser_scenario" as const;
let defaultFactory: Promise<BrowserScenarioSessionFactory> | undefined;

const lazyPlaywrightFactory: BrowserScenarioSessionFactory = {
  async open(scenario, options) {
    defaultFactory ??= import("./PlaywrightScenarioSession.js").then(
      ({ PlaywrightScenarioSessionFactory }) =>
        new PlaywrightScenarioSessionFactory(),
    );
    return (await defaultFactory).open(scenario, options);
  },
};

export const PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY: ProviderIdentity =
  Object.freeze({
    id: "rea-playwright-browser-scenario",
    name: "REA Playwright browser scenario capture provider",
    version: "1",
  });

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

const requestedForStep = (
  scenario: BrowserScenario,
  stepIndex: number,
): ReadonlySet<SnapshotKind> =>
  new Set([
    ...scenario.capture.after_each_step,
    ...(stepIndex === scenario.actions.length ? scenario.capture.at_end : []),
  ]);

const unavailableArtifacts = (
  requested: ReadonlySet<SnapshotKind>,
  reason: string,
): BrowserStepArtifacts => {
  const state = (kind: SnapshotKind) =>
    requested.has(kind)
      ? { state: "missing" as const, reason }
      : { state: "not_requested" as const };
  return browserStepArtifactsSchema.parse({
    screenshot: state("screenshot"),
    dom: state("dom"),
    accessibility: state("accessibility"),
    url: state("url"),
    history: state("history"),
    storage: state("storage"),
  });
};

const stepCompleteness = (
  artifacts: BrowserStepArtifacts,
  status: BrowserScenarioStep["status"],
): BrowserScenarioCompleteness => {
  const missing = Object.entries(artifacts)
    .filter(([, state]) => state.state === "missing")
    .map(([section]) => section);
  const truncated = Object.entries(artifacts)
    .filter(([, state]) => state.state === "truncated")
    .map(([section]) => section);
  if (status !== "completed") missing.push("action");
  const condition =
    truncated.length > 0
      ? "truncated"
      : missing.length > 0
        ? "incomplete"
        : "complete";
  return browserScenarioCompletenessSchema.parse({
    status: condition,
    equality_eligible: condition === "complete",
    missing_sections: [...new Set(missing)].sort(),
    truncated_sections: [...new Set(truncated)].sort(),
  });
};

const createStep = (input: {
  readonly stepIndex: number;
  readonly stepId: string;
  readonly action: string;
  readonly status: BrowserScenarioStep["status"];
  readonly elapsedMs: number;
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly error: string | null;
  readonly eventStart: number;
  readonly eventEnd: number;
  readonly artifacts: BrowserStepArtifacts;
}): BrowserScenarioStep =>
  browserScenarioStepSchema.parse({
    step_index: input.stepIndex,
    step_id: input.stepId,
    action: input.action,
    status: input.status,
    elapsed_ms: input.elapsedMs,
    before_url: sanitizeBrowserUrl(input.beforeUrl),
    after_url: sanitizeBrowserUrl(input.afterUrl),
    error: input.error,
    event_sequence_start: input.eventStart,
    event_sequence_end: input.eventEnd,
    artifacts: input.artifacts,
    completeness: stepCompleteness(input.artifacts, input.status),
  });

const initialStep = async (input: {
  readonly session: BrowserScenarioSessionPort;
  readonly scenario: BrowserScenario;
  readonly budget: BrowserScenarioCaptureBudget;
  readonly elapsedMs: number;
  readonly maximumTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
}): Promise<BrowserScenarioStep> => {
  const { session, scenario, budget, elapsedMs, maximumTimeoutMs, signal } =
    input;
  const artifacts = await session.capture(
    requestedForStep(scenario, 0),
    budget,
    maximumTimeoutMs,
    signal,
  );
  return createStep({
    stepIndex: 0,
    stepId: "scenario_start",
    action: "goto_start",
    status: "completed",
    elapsedMs,
    beforeUrl: session.initialUrl,
    afterUrl: session.currentUrl(),
    error: null,
    eventStart: 1,
    eventEnd: session.lastEventSequence(),
    artifacts,
  });
};

const executeStep = async (input: {
  readonly session: BrowserScenarioSessionPort;
  readonly scenario: BrowserScenario;
  readonly budget: BrowserScenarioCaptureBudget;
  readonly action: BrowserScenarioAction;
  readonly stepIndex: number;
  readonly startedAt: number;
  readonly priorFailure: boolean;
  readonly signal: AbortSignal | undefined;
}): Promise<BrowserScenarioStep> => {
  const {
    session,
    scenario,
    budget,
    action,
    stepIndex,
    startedAt,
    priorFailure,
    signal,
  } = input;
  const beforeUrl = session.currentUrl();
  const eventStart = session.nextEventSequence();
  const requested = requestedForStep(scenario, stepIndex);
  if (priorFailure)
    return createStep({
      stepIndex,
      stepId: action.step_id,
      action: action.action,
      status: "cancelled",
      elapsedMs: 0,
      beforeUrl,
      afterUrl: beforeUrl,
      error: "not executed after an earlier action failure",
      eventStart,
      eventEnd: session.lastEventSequence(),
      artifacts: unavailableArtifacts(
        requested,
        "action was not executed after an earlier failure",
      ),
    });

  const actionStartedAt = Date.now();
  session.setStep(stepIndex);
  const requestCancelled = (): boolean => signal?.aborted === true;
  let status: BrowserScenarioStep["status"] = "completed";
  let error: string | null = null;
  if (requestCancelled()) {
    status = "cancelled";
    error = "scenario request cancelled";
  } else {
    try {
      const elapsed = Date.now() - startedAt;
      const remaining = scenario.limits.max_duration_ms - elapsed;
      if (remaining <= 0) throw new Error("Scenario duration limit reached");
      await session.perform(action, remaining, signal);
    } catch (cause: unknown) {
      status = requestCancelled() ? "cancelled" : "failed";
      error = session.redactError(cause);
    }
  }
  const remaining = scenario.limits.max_duration_ms - (Date.now() - startedAt);
  const artifacts =
    status === "cancelled" || remaining <= 0
      ? unavailableArtifacts(
          requested,
          status === "cancelled"
            ? "scenario request cancelled"
            : "scenario duration limit reached",
        )
      : await session.capture(requested, budget, remaining, signal);
  return createStep({
    stepIndex,
    stepId: action.step_id,
    action: action.action,
    status,
    elapsedMs: Date.now() - actionStartedAt,
    beforeUrl,
    afterUrl: session.currentUrl(),
    error,
    eventStart,
    eventEnd: session.lastEventSequence(),
    artifacts,
  });
};

const globalCompleteness = (
  scenario: BrowserScenario,
  session: BrowserScenarioSessionPort,
  steps: readonly BrowserScenarioStep[],
): BrowserScenarioCompleteness => {
  const missing = steps.flatMap(
    ({ completeness }) => completeness.missing_sections,
  );
  const truncated = steps.flatMap(
    ({ completeness }) => completeness.truncated_sections,
  );
  truncated.push(...session.eventTruncationSections());
  if (session.mode === "connect") missing.push("events");
  const status =
    truncated.length > 0
      ? "truncated"
      : missing.length > 0
        ? "incomplete"
        : "complete";
  return browserScenarioCompletenessSchema.parse({
    status,
    equality_eligible: status === "complete",
    missing_sections: [...new Set(missing)].sort(),
    truncated_sections: [...new Set(truncated)].sort(),
  });
};

const runScenario = async (
  factory: BrowserScenarioSessionFactory,
  scenario: BrowserScenario,
  options: ExecutionOptions,
): Promise<BrowserScenarioCapture> => {
  if (options.signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
  const startedAt = Date.now();
  const budget = new BrowserScenarioCaptureBudget(
    scenario.limits.max_screenshots,
    scenario.limits.max_total_metadata_bytes,
  );
  const session = await factory.open(scenario, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    budget,
    deadlineAt: startedAt + scenario.limits.max_duration_ms,
  });
  const steps: BrowserScenarioStep[] = [];
  let cleanup: "terminated-owned-process" | "disconnected-external" | undefined;
  try {
    steps.push(
      await initialStep({
        session,
        scenario,
        budget,
        elapsedMs: Date.now() - startedAt,
        maximumTimeoutMs:
          scenario.limits.max_duration_ms - (Date.now() - startedAt),
        signal: options.signal,
      }),
    );
    let failed = false;
    for (const [offset, action] of scenario.actions.entries()) {
      const step = await executeStep({
        session,
        scenario,
        budget,
        action,
        stepIndex: offset + 1,
        startedAt,
        priorFailure: failed,
        signal: options.signal,
      });
      steps.push(step);
      failed ||= step.status !== "completed";
    }
  } finally {
    cleanup = await session.close();
  }
  const events = session.events();
  const completeness = globalCompleteness(scenario, session, steps);
  return browserScenarioCaptureSchema.parse({
    schema_version: 1,
    browser: {
      mode: session.mode,
      process_ownership: session.processOwnership,
      cleanup,
      product: session.product,
      version: session.version,
    },
    scenario: {
      start_origin: new URL(scenario.start_url.url).origin,
      allowed_origins: scenario.allowed_origins,
      action_count: scenario.actions.length,
      secret_references: scenario.secrets.map(({ secret_id: id }) => id).sort(),
    },
    duration_ms: Date.now() - startedAt,
    steps,
    events,
    completeness,
    limitations: [
      "Event sequence records provider receipt order; simultaneous browser causality is not inferred.",
      "Response bodies are not retained.",
      "Storage values are hashed only after declared-secret redaction.",
      ...(session.mode === "connect"
        ? [
            "CDP attachment cannot recover pre-attach events or guarantee launch-time context options.",
          ]
        : []),
    ],
  });
};

/** Controlled Playwright/CDP scenario driver with exact process ownership. */
export class PlaywrightBrowserScenarioProvider
  implements BrowserScenarioCapturePort
{
  constructor(
    private readonly factory: BrowserScenarioSessionFactory = lazyPlaywrightFactory,
  ) {}

  identity(): ProviderIdentity {
    return PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY;
  }

  async captureScenario(
    scenario: BrowserScenario,
    options: ExecutionOptions = {},
  ): Promise<Result<BrowserScenarioCapture, AnalysisError>> {
    try {
      return ok(await runScenario(this.factory, scenario, options));
    } catch (cause: unknown) {
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new ProviderAdapterError(
          PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY.id,
          OPERATION,
          { cause },
        ),
      );
    }
  }
}

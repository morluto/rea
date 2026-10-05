import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type {
  BrowserScenario,
  BrowserScenarioAction,
} from "../domain/browserScenario.js";
import {
  browserScenarioCaptureSchema,
  classifyBrowserScenarioCompleteness,
  browserScenarioStepSchema,
  browserStepArtifactsSchema,
  type BrowserScenarioCapture,
  type BrowserScenarioCompleteness,
  type BrowserScenarioCompletenessSection,
  type BrowserScenarioStep,
  type BrowserScenarioStepOutcome,
  type BrowserStepArtifacts,
} from "../domain/browserScenarioCapture.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  BrowserScenarioSessionFactory,
  BrowserScenarioSessionPort,
} from "./BrowserScenarioSessionPort.js";

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
const SNAPSHOT_KINDS = [
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
] as const satisfies readonly SnapshotKind[];

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
  const missing: BrowserScenarioCompletenessSection[] = SNAPSHOT_KINDS.filter(
    (section) => artifacts[section].state === "missing",
  );
  const truncated = SNAPSHOT_KINDS.filter(
    (section) => artifacts[section].state === "truncated",
  );
  if (status !== "completed") missing.push("action");
  return classifyBrowserScenarioCompleteness(missing, truncated);
};

const createStep = (
  input: {
    readonly stepIndex: number;
    readonly stepId: string;
    readonly action: string;
    readonly elapsedMs: number;
    readonly beforeUrl: ReturnType<BrowserScenarioSessionPort["sanitizeUrl"]>;
    readonly afterUrl: ReturnType<BrowserScenarioSessionPort["sanitizeUrl"]>;
    readonly eventStart: number;
    readonly eventEnd: number;
    readonly artifacts: BrowserStepArtifacts;
  } & BrowserScenarioStepOutcome,
): BrowserScenarioStep =>
  browserScenarioStepSchema.parse({
    step_index: input.stepIndex,
    step_id: input.stepId,
    action: input.action,
    status: input.status,
    elapsed_ms: input.elapsedMs,
    before_url: input.beforeUrl,
    after_url: input.afterUrl,
    error: input.error,
    event_sequence_start: input.eventStart,
    event_sequence_end: input.eventEnd,
    artifacts: input.artifacts,
    completeness: stepCompleteness(input.artifacts, input.status),
  });

const initialStep = async (input: {
  readonly session: BrowserScenarioSessionPort;
  readonly scenario: BrowserScenario;
  readonly elapsedMs: number;
  readonly signal: AbortSignal | undefined;
}): Promise<BrowserScenarioStep> => {
  const { session, scenario, elapsedMs, signal } = input;
  const artifacts = await session.capture(
    requestedForStep(scenario, 0),
    signal,
  );
  return createStep({
    stepIndex: 0,
    stepId: "scenario_start",
    action: "goto_start",
    status: "completed",
    elapsedMs,
    beforeUrl: session.sanitizeUrl(session.initialUrl),
    afterUrl: session.sanitizeUrl(session.currentUrl()),
    error: null,
    eventStart: 1,
    eventEnd: session.lastEventSequence(),
    artifacts,
  });
};

const executeStep = async (input: {
  readonly session: BrowserScenarioSessionPort;
  readonly scenario: BrowserScenario;
  readonly action: BrowserScenarioAction;
  readonly stepIndex: number;
  readonly priorFailure: boolean;
  readonly signal: AbortSignal | undefined;
}): Promise<BrowserScenarioStep> => {
  const { session, scenario, action, stepIndex, priorFailure, signal } = input;
  const beforeUrl = session.sanitizeUrl(session.currentUrl());
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
  let outcome: BrowserScenarioStepOutcome = {
    status: "completed",
    error: null,
  };
  if (requestCancelled()) {
    outcome = { status: "cancelled", error: "scenario request cancelled" };
  } else {
    try {
      await session.perform(action, signal);
    } catch (cause: unknown) {
      outcome = {
        status: requestCancelled() ? "cancelled" : "failed",
        error: session.redactError(cause),
      };
    }
  }
  const artifacts =
    outcome.status === "cancelled"
      ? unavailableArtifacts(requested, "scenario request cancelled")
      : await session.capture(requested, signal);
  return createStep({
    stepIndex,
    stepId: action.step_id,
    action: action.action,
    ...outcome,
    elapsedMs: Date.now() - actionStartedAt,
    beforeUrl,
    afterUrl: session.sanitizeUrl(session.currentUrl()),
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
  if (session.mode === "connect") missing.push("events");
  if ((session.eventLimitations?.().length ?? 0) > 0) missing.push("events");
  return classifyBrowserScenarioCompleteness(missing, truncated);
};

const runScenario = async (
  factory: BrowserScenarioSessionFactory,
  scenario: BrowserScenario,
  options: ExecutionOptions,
): Promise<BrowserScenarioCapture> => {
  if (options.signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
  const startedAt = Date.now();
  const session = await factory.open(
    scenario,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const steps: BrowserScenarioStep[] = [];
  let cleanup: "terminated-owned-process" | "disconnected-external" | undefined;
  try {
    steps.push(
      await initialStep({
        session,
        scenario,
        elapsedMs: Date.now() - startedAt,
        signal: options.signal,
      }),
    );
    let failed = false;
    for (const [offset, action] of scenario.actions.entries()) {
      const step = await executeStep({
        session,
        scenario,
        action,
        stepIndex: offset + 1,
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
    browser: {
      mode: session.mode,
      process_ownership: session.processOwnership,
      cleanup,
      product: session.product,
      version: session.version,
    },
    scenario: {
      start_origin: new URL(scenario.start_url.url).origin,
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
      ...(session.eventLimitations?.() ?? []),
      ...(session.mode === "connect"
        ? [
            "CDP attachment cannot recover pre-attach events or guarantee launch-time context options.",
          ]
        : []),
    ],
  });
};

/** Controlled Playwright/CDP scenario driver with exact process ownership. */
export class PlaywrightBrowserScenarioProvider implements BrowserScenarioCapturePort {
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

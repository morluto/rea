import type { BrowserScenario } from "../domain/browserScenario.js";
import type {
  BrowserScenarioCaptureData,
  BrowserScenarioPartialObservation,
} from "../domain/browserScenarioCapture.js";
import type { BrowserScenarioStep } from "../domain/browserScenarioCaptureValues.js";
import type { BrowserScenarioSessionPort } from "./BrowserScenarioSessionPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY } from "./providerIdentities.js";

const OPERATION = "capture_browser_scenario" as const;

const browserScenarioLimitations = (
  session: BrowserScenarioSessionPort,
  scenario: BrowserScenario,
): string[] => [
  "Event sequence records provider receipt order; simultaneous browser causality is not inferred.",
  "Network content is retained only when selected; response bytes are browser-decoded, not compressed wire bytes.",
  "Request bytes are limited to what Playwright exposes; not_exposed does not establish body absence or multipart file coverage.",
  "Network content reads settle within 5 seconds each and never wait for unfinished responses or refetch them.",
  "Playwright scenario events do not expose request initiator stacks; receipt order does not prove causality.",
  "Storage values are hashed only after declared-secret redaction.",
  ...(scenario.storage.local_storage.length > 0 ||
  scenario.storage.session_storage.length > 0
    ? [
        "Storage seeding briefly pauses provider bootstrap before application scripts; pauses from target debugger statements are resumed while capture runs.",
      ]
    : []),
  ...(session.eventLimitations?.() ?? []),
  ...(session.mode === "connect"
    ? [
        "CDP attachment cannot recover pre-attach events or guarantee launch-time context options.",
      ]
    : []),
];

/** Project one session into the common capture fields used by success and failure. */
export const browserScenarioCaptureData = (input: {
  readonly session: BrowserScenarioSessionPort;
  readonly scenario: BrowserScenario;
  readonly startedAt: number;
  readonly steps: readonly BrowserScenarioStep[];
  readonly cleanup:
    | "terminated-owned-process"
    | "disconnected-external"
    | "incomplete";
  readonly limitations?: readonly string[];
}): BrowserScenarioCaptureData => ({
  browser: {
    mode: input.session.mode,
    process_ownership: input.session.processOwnership,
    cleanup: input.cleanup,
    product: input.session.product,
    version: input.session.version,
  },
  scenario: {
    start_origin: new URL(input.scenario.start_url.url).origin,
    action_count: input.scenario.actions.length,
    secret_references: input.scenario.secrets
      .map(({ secret_id: id }) => id)
      .sort(),
    network_content: input.scenario.capture.network,
  },
  duration_ms: Date.now() - input.startedAt,
  steps: [...input.steps],
  events: input.session.events(),
  limitations: [
    ...browserScenarioLimitations(input.session, input.scenario),
    ...(input.limitations ?? []),
  ],
});

/** Describe the cleanup failure without discarding its resource evidence. */
export const browserScenarioCleanupObservation = (
  cause: unknown,
): { readonly reason: string; readonly resources: readonly string[] } =>
  cause instanceof AnalysisError && cause.cleanup !== undefined
    ? cause.cleanup
    : {
        reason: cause instanceof Error ? cause.message : String(cause),
        resources:
          cause instanceof AnalysisError && cause.cleanupResources.length > 0
            ? cause.cleanupResources
            : ["browser_transport"],
      };

/** Retain operation diagnostics and capture data after cleanup settles. */
export const browserScenarioOperationFailure = (
  cause: unknown,
  partialObservation: BrowserScenarioPartialObservation,
  cleanupFailure?: { readonly cause: unknown },
): AnalysisError => {
  const primary =
    cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(
          PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY.id,
          OPERATION,
          { cause },
        );
  const primaryProjection = projectAnalysisError(primary);
  const cleanupCause =
    cleanupFailure === undefined
      ? undefined
      : cleanupFailure.cause instanceof AnalysisError
        ? cleanupFailure.cause
        : new ProviderAdapterError(
            PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY.id,
            "close_browser_scenario",
            { cause: cleanupFailure.cause },
          );
  const cleanupObservation =
    cleanupFailure === undefined
      ? undefined
      : browserScenarioCleanupObservation(cleanupFailure.cause);
  const retainedOptions = {
    cause: primary,
    partialObservation,
    ...(primary.capturedOutput === undefined
      ? {}
      : { capturedOutput: primary.capturedOutput }),
    ...(primary.cleanup === undefined ? {} : { cleanup: primary.cleanup }),
  };
  if (cleanupCause === undefined) {
    if (primary instanceof AnalysisCancelledError)
      return new AnalysisCancelledError(primary.operation, retainedOptions);
    if (primary instanceof AnalysisTimeoutError)
      return new AnalysisTimeoutError(
        primary.operation,
        primary.timeoutMs,
        retainedOptions,
      );
    if (primary instanceof BrowserObservationError)
      return new BrowserObservationError(primary.operation, primary.reason, {
        ...retainedOptions,
        ...(primary.userMessage === undefined
          ? {}
          : { detail: primary.userMessage }),
      });
  }
  const cleanup = cleanupObservation ?? primary.cleanup;
  return new ProviderAdapterError(
    PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      ...retainedOptions,
      cause:
        cleanupCause === undefined
          ? primary
          : new AggregateError(
              [primary, cleanupCause],
              "Browser scenario operation and cleanup both failed",
              { cause: primary },
            ),
      userMessage: primaryProjection.message,
      ...(cleanup === undefined ? {} : { cleanup }),
      diagnostics: {
        primary_error: primaryProjection,
        ...(cleanupCause === undefined
          ? {}
          : { cleanup_error: projectAnalysisError(cleanupCause) }),
      },
    },
  );
};

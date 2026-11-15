import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "./BrowserScenarioEvidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import { err, type Result } from "../domain/result.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import {
  completeProviderEvidence,
  keepIncompleteObservation,
} from "./ProviderOperationExecution.js";

import { jsonValueSchema } from "../domain/jsonValue.js";

const OPERATION = "capture_browser_scenario" as const;
const PROVIDER_ID = "rea-playwright-browser-scenario";

/** Execute one controlled browser scenario using its explicit request scope. */
export const captureBrowserScenario = async (
  provider: BrowserScenarioCapturePort | undefined,
  scenario: BrowserScenario,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "browser scenario provider is not configured",
      ),
    );
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
    );
  const captured = await provider.captureScenario(scenario, options);
  if (!captured.ok) {
    keepIncompleteObservation(
      captured.error,
      OPERATION,
      "Browser scenario provider retained a non-JSON incomplete observation.",
    );
    const seen = new Set<AnalysisError>();
    const promoted = new Map<object, Evidence>();
    let owner: AnalysisError | undefined = captured.error;
    while (owner !== undefined && !seen.has(owner)) {
      seen.add(owner);
      const partial = owner.partialObservation;
      if (
        partial !== undefined &&
        "kind" in partial &&
        partial.kind === "browser-scenario-observation"
      ) {
        const report = browserScenarioCaptureSchema.safeParse(partial.capture);
        // Every cleanup primary may become the selected error after release.
        if (
          report.success &&
          report.data.steps.every(({ status }) => status === "completed")
        ) {
          const evidence =
            promoted.get(partial) ??
            createBrowserScenarioEvidence(
              scenario,
              {
                source: jsonValueSchema.parse(partial.capture),
                facts: report.data,
              },
              provider.identity(),
            );
          promoted.set(partial, evidence);
          owner.partialObservation = evidence;
        }
      }
      owner = owner.cleanupPrimary;
    }
    return captured;
  }
  const json = jsonValueSchema.safeParse(captured.value);
  if (!json.success)
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Browser scenario provider returned non-JSON capture data.",
        { cause: json.error },
      ),
    );
  const report = browserScenarioCaptureSchema.safeParse(json.data);
  if (!report.success)
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Browser scenario provider returned a malformed completed capture.",
        { cause: report.error },
      ),
    );
  return completeProviderEvidence(
    createBrowserScenarioEvidence(
      scenario,
      { source: json.data, facts: report.data },
      provider.identity(),
    ),
    options.signal,
  );
};

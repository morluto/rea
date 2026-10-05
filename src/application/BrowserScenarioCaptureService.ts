import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "./BrowserScenarioEvidence.js";
import {
  AnalysisCapabilityUnavailableError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import { err, type Result } from "../domain/result.js";

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
  const captured = await provider.captureScenario(scenario, options);
  return captured.ok
    ? {
        ok: true,
        value: createBrowserScenarioEvidence(
          scenario,
          captured.value,
          provider.identity(),
        ),
      }
    : captured;
};

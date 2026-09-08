import { projectPermissionFailure } from "./PermissionFailure.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "./BrowserScenarioEvidence.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";
import {
  AnalysisCapabilityUnavailableError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { isLiteralLoopbackHostname } from "../domain/browserObservation.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import { err, type Result } from "../domain/result.js";

const OPERATION = "capture_browser_scenario" as const;
const PROVIDER_ID = "rea-playwright-browser-scenario";

const networkScope = (origins: readonly string[]): "loopback" | "external" =>
  origins.every((origin) => isLiteralLoopbackHostname(new URL(origin).hostname))
    ? "loopback"
    : "external";

const authorizeScenario = async (
  authority: PermissionAuthority | undefined,
  scenario: BrowserScenario,
): Promise<Result<true, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "browser scenario permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "browser_automate",
      roots: [],
      executables:
        scenario.browser.mode === "launch"
          ? [scenario.browser.executable_path]
          : [],
      environment_names: scenario.secrets.map(
        ({ environment_variable: name }) => name,
      ),
      origins: [
        ...(scenario.browser.mode === "connect"
          ? [scenario.browser.cdp_endpoint]
          : []),
        ...scenario.allowed_origins,
      ],
      network: networkScope(scenario.allowed_origins),
      mount: false,
      operation_identity: `${OPERATION}:${digestJson(scenario)}`,
    },
    "write",
  );
  if (!authorized.ok) return err(projectPermissionFailure(authorized.error));
  return { ok: true, value: true };
};

/** Authorize and execute one controlled browser scenario. */
export const captureBrowserScenario = async (
  provider: BrowserScenarioCapturePort | undefined,
  authority: PermissionAuthority | undefined,
  scenario: BrowserScenario,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const authorized = await authorizeScenario(authority, scenario);
  if (!authorized.ok) return authorized;
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

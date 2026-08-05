import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "./ElectronActiveObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { ElectronActiveObservationInput } from "../domain/electronActiveObservation.js";
import { err, type Result } from "../domain/result.js";
import { createElectronActiveEvidence } from "./ElectronActiveEvidence.js";

const OPERATION = "capture_electron_scenario" as const;
const PROVIDER_ID = "rea-playwright-electron-active";

const authorize = async (
  authority: PermissionAuthority | undefined,
  input: ElectronActiveObservationInput,
): Promise<Result<true, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "active Electron observation permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "electron_automate",
      roots: [input.application_root],
      executables: [input.executable_path],
      environment_names: [],
      network: "external",
      mount: false,
      operation_identity: `${OPERATION}:${digestJson(input)}`,
    },
    "write",
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  return { ok: true, value: true };
};

/** Authorize and execute one bounded, provider-owned Electron experiment. */
export const captureElectronScenario = async (
  provider: ElectronActiveObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ElectronActiveObservationInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const authorized = await authorize(authority, input);
  if (!authorized.ok) return authorized;
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "active Electron observation provider is not configured",
      ),
    );
  const captured = await provider.capture(input, options);
  return captured.ok
    ? {
        ok: true,
        value: createElectronActiveEvidence(
          input,
          captured.value,
          provider.identity(),
        ),
      }
    : captured;
};

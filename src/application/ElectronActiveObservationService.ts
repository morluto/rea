import { realpath } from "node:fs/promises";

import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "./ElectronActiveObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { ElectronActiveObservationInput } from "../domain/electronActiveObservation.js";
import { isPathContained } from "../domain/permissionPolicy.js";
import { err, type Result } from "../domain/result.js";
import { createElectronActiveEvidence } from "./ElectronActiveEvidence.js";

const OPERATION = "capture_electron_scenario" as const;
const PROVIDER_ID = "rea-playwright-electron-active";

const canonicalizeInput = async (
  input: ElectronActiveObservationInput,
): Promise<Result<ElectronActiveObservationInput, AnalysisError>> => {
  try {
    const [executablePath, applicationPath, applicationRoot] =
      await Promise.all([
        realpath(input.executable_path),
        realpath(input.application_path),
        realpath(input.application_root),
      ]);
    if (!isPathContained(applicationRoot, applicationPath))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["application_path"],
            reason: "invalid_value",
            message:
              "application_path must remain beneath application_root after symlink resolution",
          },
        ]),
      );
    return {
      ok: true,
      value: {
        ...input,
        executable_path: executablePath,
        application_path: applicationPath,
        application_root: applicationRoot,
      },
    };
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["application_path"],
          reason: "invalid_format",
          message:
            "Electron executable, application, and root must resolve to existing paths",
        },
      ]),
    );
  }
};

const authorize = async (
  authority: PermissionAuthority | undefined,
  input: ElectronActiveObservationInput,
): Promise<Result<ElectronActiveObservationInput, AnalysisError>> => {
  const canonical = await canonicalizeInput(input);
  if (!canonical.ok) return canonical;
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
      roots: [canonical.value.application_root],
      executables: [canonical.value.executable_path],
      environment_names: [],
      network: "external",
      mount: false,
      operation_identity: `${OPERATION}:${digestJson(canonical.value)}`,
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
  return canonical;
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
  const captured = await provider.capture(authorized.value, options);
  return captured.ok
    ? {
        ok: true,
        value: createElectronActiveEvidence(
          authorized.value,
          captured.value,
          provider.identity(),
        ),
      }
    : captured;
};

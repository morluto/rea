import { dirname } from "node:path";
import { realpath } from "node:fs/promises";

import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "./ElectronActiveObservationPort.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { ElectronActiveObservationInput } from "../domain/electronActiveObservation.js";
import { err, type Result } from "../domain/result.js";
import { createElectronActiveEvidence } from "./ElectronActiveEvidence.js";

const OPERATION = "capture_electron_scenario" as const;
const PROVIDER_ID = "rea-playwright-electron-active";
type CanonicalElectronActiveObservationInput =
  ElectronActiveObservationInput & {
    readonly application_root: string;
  };

const canonicalizeInput = async (
  input: ElectronActiveObservationInput,
): Promise<Result<CanonicalElectronActiveObservationInput, AnalysisError>> => {
  try {
    const [executablePath, applicationPath] = await Promise.all([
      realpath(input.executable_path),
      realpath(input.application_path),
    ]);
    const applicationRoot =
      input.application_root === undefined
        ? dirname(applicationPath)
        : await realpath(input.application_root);
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

/** Canonicalize request paths and execute one provider-owned Electron run. */
export const captureElectronScenario = async (
  provider: ElectronActiveObservationPort | undefined,
  input: ElectronActiveObservationInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const canonical = await canonicalizeInput(input);
  if (!canonical.ok) return canonical;
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "active Electron observation provider is not configured",
      ),
    );
  const captured = await provider.capture(canonical.value, options);
  return captured.ok
    ? {
        ok: true,
        value: createElectronActiveEvidence(
          canonical.value,
          captured.value,
          provider.identity(),
        ),
      }
    : captured;
};

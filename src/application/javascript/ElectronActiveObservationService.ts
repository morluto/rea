import { dirname } from "node:path";
import { realpath } from "node:fs/promises";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type {
  CanonicalElectronActiveObservationInput,
  ElectronActiveObservationPort,
} from "./ElectronActiveObservationPort.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { ElectronActiveObservationInput } from "../../domain/javascript/electronActiveObservation.js";
import { err, ok, type Result } from "../../domain/result.js";
import { createElectronActiveEvidence } from "./ElectronActiveEvidence.js";

const OPERATION = "capture_electron_scenario" as const;
const PROVIDER_ID = "rea-playwright-electron-active";

const resolveInputPath = async (
  field: "executable_path" | "application_path" | "application_root",
  selected: string,
): Promise<
  Result<
    string,
    { readonly issue: AnalysisInputIssue; readonly cause: unknown }
  >
> => {
  try {
    return ok(await realpath(selected));
  } catch (cause: unknown) {
    return err({
      issue: {
        path: [field],
        reason: "invalid_value",
        message: `Cannot resolve ${field} ${selected}: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      cause,
    });
  }
};

const canonicalizeInput = async (
  input: ElectronActiveObservationInput,
): Promise<Result<CanonicalElectronActiveObservationInput, AnalysisError>> => {
  const [executable, application, root] = await Promise.all([
    resolveInputPath("executable_path", input.executable_path),
    resolveInputPath("application_path", input.application_path),
    input.application_root === undefined
      ? Promise.resolve(ok(undefined))
      : resolveInputPath("application_root", input.application_root),
  ]);
  if (!executable.ok || !application.ok || !root.ok) {
    const failures = [executable, application, root].flatMap((result) =>
      result.ok ? [] : [result.error],
    );
    return err(
      new AnalysisInputError(
        OPERATION,
        {
          cause: new AggregateError(
            failures.map(({ cause }) => cause),
            "Electron paths could not be resolved",
          ),
        },
        failures.map(({ issue }) => issue),
      ),
    );
  }
  return ok({
    ...input,
    executable_path: executable.value,
    application_path: application.value,
    application_root: root.value ?? dirname(application.value),
  });
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

import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import type { Evidence } from "../domain/evidence.js";
import type {
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../domain/electronObservation.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import { createElectronEvidence } from "./ElectronEvidence.js";

/** List local file pages exposed by the explicitly selected endpoint. */
export const listElectronTargets = async (
  provider: ElectronObservationPort | undefined,
  input: ListElectronTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "list_electron_targets");
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? ok(
        createElectronEvidence(
          "list_electron_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Inspect one local file page from the explicitly selected endpoint. */
export const inspectElectronPage = async (
  provider: ElectronObservationPort | undefined,
  input: InspectElectronPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "inspect_electron_page");
  if (!ready.ok) return ready;
  const result = await ready.value.inspectPage(input, options);
  return result.ok
    ? ok(
        createElectronEvidence(
          "inspect_electron_page",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

const requireProvider = (
  provider: ElectronObservationPort | undefined,
  operation: "list_electron_targets" | "inspect_electron_page",
): Result<ElectronObservationPort, AnalysisError> =>
  provider === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-electron",
          operation,
          "Electron observation provider is not configured",
        ),
      )
    : ok(provider);

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import type { Evidence } from "../../domain/evidence.js";
import type {
  ElectronPageInspection,
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../../domain/javascript/electronObservation.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { createElectronEvidence } from "./ElectronEvidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../../domain/jsonValue.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
} from "../../domain/javascript/electronObservation.js";
import {
  completeProviderEvidence,
  keepIncompleteObservation,
} from "../ProviderOperationExecution.js";

/** List local file pages exposed by the explicitly selected endpoint. */
export const listElectronTargets = async (
  provider: ElectronObservationPort | undefined,
  input: ListElectronTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "list_electron_targets");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("list_electron_targets", {
        cause: options.signal.reason,
      }),
    );
  const result = await ready.value.listTargets(input, options);
  if (!result.ok) return result;
  const json = jsonValueSchema.safeParse(result.value);
  if (!json.success)
    return err(
      new AnalysisOutputError(
        "list_electron_targets",
        "Electron provider returned non-JSON target data.",
        { cause: json.error },
      ),
    );
  const report = electronTargetListSchema.safeParse(json.data);
  if (!report.success)
    return err(
      new AnalysisOutputError(
        "list_electron_targets",
        "Electron provider returned a malformed target list.",
        { cause: report.error },
      ),
    );
  return completeProviderEvidence(
    createElectronEvidence(
      "list_electron_targets",
      input,
      { source: json.data, facts: report.data },
      ready.value.identity(),
    ),
    options.signal,
  );
};

/** Inspect one local file page from the explicitly selected endpoint. */
export const inspectElectronPage = async (
  provider: ElectronObservationPort | undefined,
  input: InspectElectronPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "inspect_electron_page");
  if (!ready.ok) return ready;
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_electron_page", {
        cause: options.signal.reason,
      }),
    );
  const result = await ready.value.inspectPage(input, options);
  if (!result.ok) {
    const partial = jsonObjectSchema.safeParse(result.error.partialObservation);
    if (partial.success && partial.data.kind === "electron-page-observation") {
      const report = electronPageInspectionSchema.safeParse(
        partial.data.inspection,
      );
      if (report.success) {
        const mismatch = pageSelectionFailure(input, report.data);
        if (mismatch !== undefined) {
          result.error.retainSecondaryFailure(mismatch);
          return err(
            keepIncompleteObservation(
              result.error,
              "inspect_electron_page",
              "Electron provider retained a non-JSON incomplete observation.",
            ),
          );
        }
        const inspection = {
          ...report.data,
          limitations: [
            ...report.data.limitations,
            partial.data.cleanup === "transport-closed"
              ? "REA closed its CDP transport; this does not imply target shutdown."
              : "CDP transport cleanup remains incomplete.",
          ],
        } satisfies ElectronPageInspection;
        result.error.partialObservation = createElectronEvidence(
          "inspect_electron_page",
          input,
          {
            source: jsonValueSchema.parse(partial.data.inspection),
            facts: inspection,
          },
          ready.value.identity(),
        );
        return result;
      }
    }
    return err(
      keepIncompleteObservation(
        result.error,
        "inspect_electron_page",
        "Electron provider retained a non-JSON incomplete observation.",
      ),
    );
  }
  const json = jsonValueSchema.safeParse(result.value);
  if (!json.success)
    return err(
      new AnalysisOutputError(
        "inspect_electron_page",
        "Electron provider returned non-JSON page data.",
        { cause: json.error },
      ),
    );
  const report = electronPageInspectionSchema.safeParse(json.data);
  if (!report.success)
    return err(
      new AnalysisOutputError(
        "inspect_electron_page",
        "Electron provider returned a malformed page inspection.",
        { cause: report.error },
      ),
    );
  const mismatch = pageSelectionFailure(input, report.data);
  if (mismatch !== undefined)
    return err(mismatch.retainPartialObservation(report.data));
  return completeProviderEvidence(
    createElectronEvidence(
      "inspect_electron_page",
      input,
      { source: json.data, facts: report.data },
      ready.value.identity(),
    ),
    options.signal,
  );
};

/** Retained facts must describe the page and window the caller selected. */
const pageSelectionFailure = (
  input: InspectElectronPageInput,
  report: ElectronPageInspection,
): AnalysisOutputError | undefined =>
  report.target.target_id !== input.target_id ||
  report.capture_window.observation_ms !== input.observation_ms
    ? new AnalysisOutputError(
        "inspect_electron_page",
        "Electron provider changed the selected page or observation window.",
      )
    : undefined;

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

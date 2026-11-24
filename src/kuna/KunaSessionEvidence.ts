import { join } from "node:path";

import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../ports/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Evidence, EvidenceLocation } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { PseudocodeAbsence } from "../domain/native/pseudocodeAbsence.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import { err, type Result } from "../domain/result.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import {
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
} from "../resources/index.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type { KunaInstallation } from "./KunaInstallation.js";
import { KUNA_PROVIDER_ID, KUNA_VERIFIED_VERSION } from "./KunaRelease.js";
import type { KunaProject } from "./KunaCacheManifest.js";
import type { KunaProjectFileSpan } from "./KunaProjectReader.js";

/** Where one answer's text came from, recorded in its raw result. */
export type KunaAnswerSource =
  | { readonly kind: "project-export"; readonly project: KunaProject }
  | { readonly kind: "single-function" };

export interface KunaAnswer {
  readonly result: JsonValue;
  readonly pseudocodeAbsence?: PseudocodeAbsence;
  readonly source: KunaAnswerSource | null;
  readonly files?: readonly KunaProjectFileSpan[];
  readonly locations: readonly EvidenceLocation[];
  readonly limitations: readonly string[];
  readonly referenceSource?: JsonValue;
  readonly callDestinationEvidence?: Evidence;
  readonly requiresSourceEvidence?: true;
  readonly stringSource?: JsonValue;
  readonly relationshipCoverage?: RelationshipCoverage;
  readonly referenceClassifications?: AnalysisExecution["referenceClassifications"];
  readonly referenceCoverageGaps?: AnalysisExecution["referenceCoverageGaps"];
  readonly siblingUnavailability?: AnalysisCapabilityUnavailableError;
}

/**
 * Wait for work this session owns, stopping only this caller's wait when its
 * signal aborts; the work itself continues for other callers.
 */
export const waitForKunaWork = async <T>(
  work: Promise<Result<T, AnalysisError>>,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<Result<T, AnalysisError>> => {
  const result = await waitForAbortable(work, signal);
  return result instanceof AbortedWait
    ? err(cancelledBy(operation, result))
    : result;
};

/** An adopted export file disappeared or changed since its digest was verified. */
export const isUnavailableProject = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" ||
    cause.code === "ENOTDIR" ||
    cause.code === "ESTALE");

/** How one Kuna session operation reports a failure nothing typed it as. */
export const kunaSessionDialect = (
  operation: string,
): ProviderFailureDialect => ({
  providerId: KUNA_PROVIDER_ID,
  operation,
  unclassified: (cause) =>
    new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
      cause,
      userMessage: `Kuna ${operation} failed: ${errorMessage(cause)}`,
    }),
});

/** Bind a refused descriptor retry to the leases that still own those handles. */
export const descriptorCleanupError = (
  cause: ArtifactReaderFailure,
  operation: string,
): ProviderCleanupError => {
  const observation = ArtifactReaderFailure.cleanupObservation(
    cause,
    "Kuna provider file descriptor",
  );
  const error = new ProviderCleanupError(
    KUNA_PROVIDER_ID,
    observation.resources,
    { reason: observation.reason },
    { cause, operation },
  );
  bindArtifactFileCleanup(cause, error);
  return error;
};

export const FAILED_PROJECT_RECORDS_GUIDANCE =
  "REA does not expose per-function records from a failed project export.";

/**
 * Operations that unconditionally require Kuna's shared project export and
 * cannot answer from the quick function inventory, reference walk, or a
 * standalone single-function decompile run.
 */
const KUNA_PROJECT_DEPENDENT_OPERATIONS = Object.freeze([
  "procedure_assembly",
  "analyze_function",
] as const satisfies readonly string[]);

const exportUnavailableMessage = (
  operation: string,
  reason: string,
  next: string,
): string =>
  `Kuna's project export failed, so ${operation} is unavailable in this session: ${reason.replace(/\.?$/u, ".")} ${FAILED_PROJECT_RECORDS_GUIDANCE} Inspect any captured diagnostics. ${next}`;

/**
 * How a request that needs the export reports the export's failure. A session
 * never rebuilds a failed export, so repeating the request cannot succeed; the
 * error says what to change before reopening the target. A failed export is
 * not rebuilt in the same session. The project deadline can change at runtime
 * for the next export. Cancellation and unproven cleanup keep their own
 * errors, which callers must still observe.
 */
export const exportUnavailable = (
  operation: string,
  failure: AnalysisError,
): AnalysisError => {
  if (failure instanceof AnalysisCancelledError || failure.cleanupIncomplete)
    return failure;
  const reason = failure.userMessage ?? failure.message;
  const exported = projectAnalysisError(failure);
  const restart =
    "REA reads Kuna settings when it starts, so restart REA, then reopen the target.";
  const next =
    failure instanceof AnalysisTimeoutError
      ? `To retry, set kuna.project_timeout_ms above ${String(failure.timeoutMs)} ms with update_analysis_settings. It can be changed at runtime. The launch seed is REA_KUNA_PROJECT_TIMEOUT_MS. Then reopen the target so the export runs again.`
      : failure instanceof AnalysisResourceConstraintError &&
          failure.remediationAction !== undefined
        ? // A fixed buffer (`memory`) is no setting, so a restart cannot help.
          `${failure.remediationAction.replace(/\.?$/u, ".")}${failure.resource === "memory" ? "" : ` ${restart}`}`
        : "To retry, resolve the reported failure, then reopen the target.";
  const userMessage = exportUnavailableMessage(operation, reason, next);
  const siblingReasons = Object.freeze(
    Object.fromEntries(
      KUNA_PROJECT_DEPENDENT_OPERATIONS.map((sibling) => [
        sibling,
        exportUnavailableMessage(sibling, reason, next),
      ]),
    ),
  );
  return new AnalysisCapabilityUnavailableError(
    KUNA_PROVIDER_ID,
    operation,
    reason,
    {
      cause: failure,
      siblingOperations: KUNA_PROJECT_DEPENDENT_OPERATIONS,
      siblingReasons,
      remediationAction: next,
      // Callers see only the top-level projection, so the export failure's
      // own projected code and details (its limits, target path, captured
      // output and diagnostics) travel whole rather than field by field.
      diagnostics: {
        export_error: failure._tag,
        export_code: exported.code,
        failed_project_records: "not_exposed",
        ...(exported.details === undefined
          ? {}
          : { export_details: exported.details }),
      },
      userMessage,
    },
  );
};

/** Version verification is observation context, not an analysis input. */
export const kunaVerificationLimitations = (
  installation: KunaInstallation,
): readonly string[] =>
  installation.verified
    ? []
    : [
        `Kuna ${installation.version} is not REA's verified ${KUNA_VERIFIED_VERSION} release; its project layout is unverified. Version matching does not authenticate the executable.`,
      ];

/** Project one Kuna session answer into a full {@link AnalysisExecution}. */
export const buildKunaExecution = (
  operationLimitations: readonly string[],
  installation: KunaInstallation,
  answer: KunaAnswer,
  exportState: JsonValue,
  targetPath: string,
  profile: AnalysisExecution["analysisProfile"],
): AnalysisExecution => {
  const source = answer.source;
  const files =
    source?.kind !== "project-export"
      ? []
      : (answer.files ?? []).map((file) => ({
          facet: file.facet,
          file: file.path,
          file_sha256:
            Object.values(source.project.manifest.files).find(
              ({ path }) => path === file.path,
            )?.sha256 ?? null,
          byte_offset: file.byteOffset,
          byte_length: file.byteLength,
        }));
  // Preserve the direct text source shape; combined answers retain every
  // component once, including its producing file digest and byte range.
  const recordedFiles =
    files.length === 1 ? files[0] : files.length === 0 ? {} : { files };
  const rawSource =
    source === null
      ? undefined
      : source.kind === "single-function"
        ? { kind: "single-function" }
        : {
            kind: "project-export",
            key: source.project.key,
            directory: source.project.directory,
            ...recordedFiles,
          };
  const file = files.length === 1 ? files[0] : undefined;
  const sourceDescriptor =
    source?.kind === "single-function"
      ? { kind: "single-function-decompile" as const }
      : source?.kind === "project-export" && file?.file_sha256 != null
        ? {
            kind: "file-range" as const,
            path: join(source.project.directory, file.file),
            sha256: file.file_sha256,
            byte_offset: file.byte_offset,
            byte_length: file.byte_length,
          }
        : undefined;
  return createAnalysisExecution(
    answer.result,
    {
      id: KUNA_PROVIDER_ID,
      name: "Kuna",
      version: installation.version,
    },
    {
      ...(sourceDescriptor === undefined ? {} : { sourceDescriptor }),
      ...(answer.pseudocodeAbsence === undefined
        ? {}
        : { pseudocodeAbsence: answer.pseudocodeAbsence }),
      // Kuna's identity is in the analysis profile; the raw result records
      // only where file-backed text came from.
      ...(source === null &&
      answer.pseudocodeAbsence === undefined &&
      answer.referenceSource === undefined &&
      answer.stringSource === undefined
        ? {}
        : {
            rawResult: {
              ...(answer.pseudocodeAbsence === undefined
                ? {}
                : { pseudocode_absence: answer.pseudocodeAbsence }),
              ...(source === null
                ? {}
                : {
                    source: rawSource,
                    project_export: exportState,
                  }),
              ...(answer.referenceSource === undefined
                ? {}
                : { references: answer.referenceSource }),
              ...(answer.stringSource === undefined
                ? {}
                : { strings: answer.stringSource }),
            },
          }),
      limitations: [
        ...operationLimitations,
        ...kunaVerificationLimitations(installation),
        ...answer.limitations,
      ],
      ...(answer.relationshipCoverage === undefined
        ? {}
        : { relationshipCoverage: answer.relationshipCoverage }),
      ...(answer.requiresSourceEvidence === undefined
        ? {}
        : { requiresSourceEvidence: answer.requiresSourceEvidence }),
      ...(answer.callDestinationEvidence === undefined
        ? {}
        : { sourceEvidence: [answer.callDestinationEvidence] }),
      ...(answer.referenceCoverageGaps === undefined
        ? {}
        : { referenceCoverageGaps: answer.referenceCoverageGaps }),
      ...(answer.referenceClassifications === undefined
        ? {}
        : { referenceClassifications: answer.referenceClassifications }),
      ...(answer.siblingUnavailability === undefined
        ? {}
        : { siblingUnavailability: answer.siblingUnavailability }),
      locations: [
        { kind: "artifact-path", path: targetPath },
        ...answer.locations,
      ],
      ...(profile === undefined ? {} : { analysisProfile: profile }),
    },
  );
};

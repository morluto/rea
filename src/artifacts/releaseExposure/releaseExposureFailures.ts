import {
  ArtifactReaderFailure,
  asarHeaderAdmissionRecovery,
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  projectStableArtifactFailure,
  readerIntegrityFailure,
  type ArtifactFilePrimaryFacts,
} from "../../resources/index.js";
import type { ArtifactAdmissionLimit } from "../../domain/artifactOperationError.js";
import { analysisSettingLimit } from "../../domain/analysisSettingDefinitions.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { RELEASE_EXPOSURE_PROVIDER } from "../../domain/investigationProviders.js";
import { MAX_RELEASE_EXPOSURE_FILE_BYTES } from "../../domain/releaseExposure.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { errorMessage } from "../../kernel/errorMessage.js";

const OPERATION = "inspect_release_exposure";
const PROVIDER_ID = RELEASE_EXPOSURE_PROVIDER.id;

export const fileSizeRecovery = (maxFileBytes: number) =>
  maxFileBytes >= MAX_RELEASE_EXPOSURE_FILE_BYTES
    ? fixedAllowanceOptions("The release exposure input allowance", "input", {
        limit: MAX_RELEASE_EXPOSURE_FILE_BYTES,
        unit: "bytes",
      })
    : {
        retryable: false as const,
        remediationAction: `Raise max_file_bytes above ${String(maxFileBytes)} bytes or select a smaller artifact. The ceiling is ${String(MAX_RELEASE_EXPOSURE_FILE_BYTES)} bytes.`,
      };

/**
 * The header admission is its own bound, not the selected-file ceiling, so
 * max_file_bytes cannot repair it. The recovery names the shared setting the
 * composition threaded into this reader.
 */
const asarHeaderAdmissionFailure = (
  cause: ArtifactReaderFailure,
  admission: ArtifactAdmissionLimit,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "capacity",
    admission.requiredBytes === undefined
      ? `An ASAR header/index exceeds ${String(admission.maximumBytes)} bytes.`
      : `An ASAR header/index of ${String(admission.requiredBytes)} bytes exceeds ${String(admission.maximumBytes)} bytes.`,
    {
      asar_max_header_bytes: admission.maximumBytes,
      ...(admission.requiredBytes === undefined
        ? {}
        : { required_header_bytes: admission.requiredBytes }),
    },
    {
      cause,
      retryable: false,
      remediationAction: asarHeaderAdmissionRecovery(admission),
      limit: {
        ...analysisSettingLimit(
          "asar.max_header_bytes",
          admission.maximumBytes,
          admission.source,
        ),
        ...(admission.requiredBytes === undefined
          ? {}
          : { required_value: admission.requiredBytes }),
      },
    },
  );

export const releaseExposureLimitFailure = (
  cause: ArtifactReaderFailure,
  maxFileBytes: number,
): AnalysisResourceConstraintError =>
  cause.admission === undefined
    ? new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: maxFileBytes },
        { cause, ...fileSizeRecovery(maxFileBytes) },
      )
    : asarHeaderAdmissionFailure(cause, cause.admission);

const releaseExposureFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  path: string,
  maxFileBytes: number,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return readerIntegrityFailure(OPERATION, path, cause);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return cancelledBy(
      OPERATION,
      carriedReason(artifactFileCancellationCause(cause)),
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return releaseExposureLimitFailure(cause, maxFileBytes);
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(PROVIDER_ID, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: errorMessage(cause),
    },
  });
};

export const releaseExposureFailure = (
  cause: unknown,
  path: string,
  maxFileBytes: number,
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    releaseExposureFailurePrimary(
      artifactFilePrimaryFacts(cause),
      path,
      maxFileBytes,
    ),
    path,
    PROVIDER_ID,
    OPERATION,
  );

import type { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { EvidenceBundleExportReceipt } from "../domain/investigationLifecycle.js";
import { jsonValueValidationIssue } from "../domain/jsonValue.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import {
  estimateJsonStorage,
  requireAuthenticationHeadroom,
} from "./JsonAuthenticationHeadroom.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { isRecord } from "../kernel/isRecord.js";

import { boundedValidationFailure } from "../domain/validationFailure.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { evidenceFileTarget, type Evidence } from "../domain/evidence.js";
import {
  safeParseImmutableEvidenceBundle,
  safeParseEvidenceBundle,
  isImmutableEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  safeParseImmutableEvidence,
  unsupportedEvidenceFormatError,
} from "../domain/evidenceValidation.js";
import {
  EVIDENCE_FORMAT_REVISION,
  isUnsupportedEvidenceFormat,
} from "../domain/evidenceFormat.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  AnalysisCancelledError,
  type AnalysisInputIssue,
  type AnalysisResourceConstraintError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { projectInputIssuesBounded } from "../domain/inputIssueProjection.js";
import { safeParseProcessCapture } from "../domain/process/processCaptureParsing.js";
import {
  bufferedJsonParts,
  canonicalJsonParts,
} from "../domain/jsonSerialization.js";
import {
  evidenceFileEnvelopeKind,
  snapshotWrongEvidenceKind,
} from "./EvidenceFileEnvelope.js";
import { readJsonFile } from "./JsonFiles.js";
import {
  writeTextParts,
  type ArtifactResourceScope,
} from "../resources/index.js";

type EvidenceBundleFileFailure =
  | EvidenceFileError
  | EvidenceIntegrityError
  | AnalysisResourceConstraintError
  | AnalysisCancelledError;

/** Project a published bundle with record and residual-unknown revision counts. */
export const evidenceBundleExportReceipt = (
  bundle: EvidenceBundle,
  published: PublishedEvidenceFile,
): EvidenceBundleExportReceipt => ({
  path: published.path,
  bytes: published.bytes,
  records: bundle.records.length,
  unknowns: bundle.unknowns.length,
});

/** Read and validate an evidence bundle at the caller-supplied path. */
export const readEvidenceBundle = (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "import_evidence_bundle",
): Promise<Result<EvidenceBundle, EvidenceBundleFileFailure>> =>
  readBundle(path, false, signal, resources, operation);

/** Read an authenticated immutable snapshot for a subsequent session import. */
export const readImmutableEvidenceBundle = (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "import_evidence_bundle",
): Promise<Result<EvidenceBundle, EvidenceBundleFileFailure>> =>
  readBundle(path, true, signal, resources, operation);

/** Join both comparison reads and preserve cleanup owned by either failed input. */
export const readComparisonEvidenceBundles = async (
  leftPath: string,
  rightPath: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "compare_bundles",
): Promise<
  Result<
    { readonly left: EvidenceBundle; readonly right: EvidenceBundle },
    AnalysisError
  >
> => {
  const [left, right] = await Promise.all([
    readImmutableEvidenceBundle(leftPath, signal, resources, operation),
    readImmutableEvidenceBundle(rightPath, signal, resources, operation),
  ]);
  if (!left.ok) {
    if (!right.ok && right.error.cleanupIncomplete)
      return err(
        analysisErrorWithCleanupDependencies(
          left.error,
          right.error,
          operation,
        ),
      );
    return left;
  }
  if (!right.ok) return right;
  return ok({ left: left.value, right: right.value });
};

const readBundle = async (
  path: string,
  immutable: boolean,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "import_evidence_bundle",
): Promise<Result<EvidenceBundle, EvidenceBundleFileFailure>> => {
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  const loaded = await readJsonFile(path, signal, resources, operation);
  if (!loaded.ok) return loaded;
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  if (evidenceFileEnvelopeKind(loaded.value) === "analysis-snapshot")
    return err(snapshotWrongEvidenceKind(path, operation, "bundle"));
  return authenticateEvidenceBundleValue(loaded.value, path, {
    operation,
    immutable,
  });
};

/**
 * Budget for projected field-level diagnostics. A malformed file can carry tens
 * of thousands of issues, and projecting all of them pushes the error past the
 * MCP response budget, which then hides the typed file error and its path. Keep
 * the leading issues that fit and say how many were omitted.
 */
const EVIDENCE_CONTENT_ISSUE_BUDGET_BYTES = 65_536;

/** Project schema issues inside a bounded byte budget with an explicit omission note. */
export const boundedEvidenceContentIssues = (
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): readonly AnalysisInputIssue[] => {
  const bounded = projectInputIssuesBounded(
    issues,
    input,
    EVIDENCE_CONTENT_ISSUE_BUDGET_BYTES,
  );
  if (bounded.omittedIssueCount === 0) return bounded.issues;
  return [
    ...bounded.issues,
    {
      path: [],
      reason: "invalid_value",
      message: `${String(bounded.omittedIssueCount)} of ${String(issues.length)} validator issues were omitted because they do not fit the response budget; repair the reported fields and retry.`,
    },
  ];
};

const EMPTY_EVIDENCE_BUNDLE_SHELL = {
  evidence_format: EVIDENCE_FORMAT_REVISION,
  artifacts: [],
  providers: [],
  environments: [],
  scenarios: [],
  captures: [],
  unknowns: [],
  records: [],
} as const;

/** Incremental representation and escaped JSON budget across admitted pack records. */
export interface BundlePackWorkingSetBudget {
  readonly valueBytes: number;
  readonly serializedUtf16Bytes: number;
}

const BUNDLE_RECORD_INDEX_OVERHEAD_BYTES = 128;

const bundleRecordAdditionalStorage = (
  record: Evidence,
): BundlePackWorkingSetBudget => {
  const fileTarget = evidenceFileTarget(record);
  const manifestAdditions: unknown[] = [
    record.provider,
    ...(record.environment === null ? [] : [record.environment]),
    ...(fileTarget === undefined
      ? []
      : [
          {
            digest: { sha256: fileTarget.sha256 },
            format: fileTarget.format,
            architecture: fileTarget.architecture,
          },
        ]),
    ...(record.authority === "controlled-replay"
      ? [
          {
            evidence_id: record.evidence_id,
            operation: record.operation,
            authority: record.authority,
          },
        ]
      : []),
    ...(record.predicate_type === "rea.process-capture"
      ? [
          {
            evidence_id: record.evidence_id,
            predicate_type: record.predicate_type,
          },
        ]
      : []),
  ];
  const recordStorage = estimateJsonStorage(record);
  const manifestStorage = estimateJsonStorage(manifestAdditions);
  return {
    valueBytes:
      recordStorage.valueBytes +
      manifestStorage.valueBytes +
      BUNDLE_RECORD_INDEX_OVERHEAD_BYTES,
    serializedUtf16Bytes:
      recordStorage.serializedUtf16Bytes + manifestStorage.serializedUtf16Bytes,
  };
};

/** Reserve cumulative heap headroom for constructing and writing the combined bundle before adding a record. */
export const admitBundlePackRecordHeadroom = (
  record: Evidence,
  accumulated: BundlePackWorkingSetBudget,
  callerPath: string,
  availableBytes?: number,
): Result<BundlePackWorkingSetBudget, AnalysisResourceConstraintError> => {
  const delta = bundleRecordAdditionalStorage(record);
  const next: BundlePackWorkingSetBudget = {
    valueBytes: accumulated.valueBytes + delta.valueBytes,
    serializedUtf16Bytes:
      accumulated.serializedUtf16Bytes + delta.serializedUtf16Bytes,
  };
  const headroom = requireAuthenticationHeadroom(EMPTY_EVIDENCE_BUNDLE_SHELL, {
    operation: "pack_evidence_bundle",
    path: callerPath,
    description:
      "Insufficient heap headroom to construct the combined Evidence bundle",
    additional: next,
    ...(availableBytes === undefined ? {} : { availableBytes }),
  });
  return headroom.ok ? ok(next) : headroom;
};

/** Read and authenticate one standalone Evidence JSON record at the caller-supplied path. */
export const readStandaloneEvidenceRecord = async (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "pack_evidence_bundle",
): Promise<Result<Evidence, EvidenceBundleFileFailure>> => {
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  const loaded = await readJsonFile(path, signal, resources, operation);
  if (!loaded.ok) return loaded;
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  return authenticateStandaloneEvidenceValue(loaded.value, path, operation);
};

const authenticateStandaloneEvidenceValue = (
  value: unknown,
  path: string,
  operation: string,
): Result<Evidence, EvidenceBundleFileFailure> => {
  const callerPath = absoluteCallerPath(path);
  const kind = evidenceFileEnvelopeKind(value);
  if (kind === "analysis-snapshot")
    return err(snapshotWrongEvidenceKind(path, operation, "record"));
  if (kind === "evidence-bundle") {
    const bundle = authenticateEvidenceBundleValue(value, path, {
      operation,
      immutable: true,
    });
    if (!bundle.ok) return bundle;
    return err(
      new EvidenceFileError("read", "wrong-kind", {
        path: callerPath,
        detectedKind: "evidence-bundle",
        userMessage:
          "Expected a standalone Evidence record JSON file, but this JSON is an Evidence bundle. Supply standalone Evidence JSON files, or export an existing bundle directly.",
      }),
    );
  }
  const headroom = requireAuthenticationHeadroom(value, {
    operation,
    path: callerPath,
    description:
      "Insufficient heap headroom to authenticate the Evidence record",
  });
  if (!headroom.ok) return headroom;
  const parsed = safeParseImmutableEvidence(value);
  if (!parsed.ok) {
    if (isUnsupportedEvidenceFormat(parsed.error))
      return err(unsupportedEvidenceFormatError(parsed.error));
    if (isRecord(value) && Object.hasOwn(value, "evidence_id")) {
      const fixedMessageBytes =
        1024 +
        3 *
          jsonStringByteLength(callerPath, EVIDENCE_CONTENT_ISSUE_BUDGET_BYTES);
      const bounded = boundedValidationFailure(parsed.error, {
        budgetBytes: Math.max(
          0,
          EVIDENCE_CONTENT_ISSUE_BUDGET_BYTES - fixedMessageBytes,
        ),
        within: [],
        descriptionCopies: 3,
      });
      const message = `Evidence validation failed ${bounded.description}`;
      return err(
        new EvidenceIntegrityError(message, {
          cause: parsed.error,
          userMessage: `${message}. Recreate or repair the Evidence file at ${callerPath}, then try again.`,
          diagnostics: { path: callerPath },
          ...(bounded.issuePath === undefined
            ? {}
            : { issuePath: bounded.issuePath }),
          ...(bounded.constraint === undefined
            ? {}
            : { constraint: bounded.constraint }),
          ...(bounded.remainingIssueCount === undefined
            ? {}
            : { remainingIssueCount: bounded.remainingIssueCount }),
        }),
      );
    }
    return err(
      new EvidenceFileError("read", "wrong-kind", {
        path: callerPath,
        cause: parsed.error,
        contentIssues: boundedEvidenceContentIssues(parsed.error.issues, value),
        userMessage:
          "The selected file does not contain a valid standalone Evidence record. Repair or recreate the file and try again.",
      }),
    );
  }
  const validated = validateRecordsPayloads([parsed.value], path, operation);
  return validated.ok ? ok(parsed.value) : validated;
};

/** Authenticate a loaded bundle once, preserving file-reader failure and process-capture semantics. */
export const authenticateEvidenceBundleValue = (
  value: unknown,
  path: string,
  options: { readonly operation: string; readonly immutable?: boolean },
): Result<EvidenceBundle, EvidenceBundleFileFailure> => {
  const { operation } = options;
  const headroom = requireAuthenticationHeadroom(value, {
    operation,
    path: absoluteCallerPath(path),
    description:
      "Insufficient heap headroom to authenticate the Evidence bundle",
  });
  if (!headroom.ok) return headroom;
  const parsed =
    options.immutable === true
      ? safeParseImmutableEvidenceBundle(value)
      : safeParseEvidenceBundle(value);
  if (!parsed.ok) {
    const failure = parsed.error;
    if (failure.kind === "single-record")
      return err(
        new EvidenceFileError("read", "wrong-kind", {
          path: absoluteCallerPath(path),
          cause: failure.cause,
          detectedKind: "evidence-record",
          userMessage: failure.message,
        }),
      );
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause: failure.cause,
        userMessage: failure.message,
      }),
    );
  }
  return validateBundlePayloads(parsed.value, path, operation);
};

/** Validate typed payloads without restricting historical workflow or provider identities. */
const validateBundlePayloads = (
  bundle: EvidenceBundle,
  path: string,
  operation: string,
): Result<
  EvidenceBundle,
  EvidenceIntegrityError | AnalysisResourceConstraintError
> => {
  const validated = validateRecordsPayloads(bundle.records, path, operation);
  return validated.ok ? ok(bundle) : validated;
};

const validateRecordsPayloads = (
  records: readonly Evidence[],
  path: string,
  operation: string,
): Result<void, EvidenceIntegrityError | AnalysisResourceConstraintError> => {
  for (const record of records) {
    if (record.predicate_type !== "rea.process-capture") continue;
    // A sealed bundle borrows records, but this typed parser still allocates a
    // capture copy. Admit its actual working set against current headroom.
    const headroom = requireAuthenticationHeadroom(record.normalized_result, {
      operation,
      path: absoluteCallerPath(path),
      description: `Insufficient heap headroom to validate process capture ${record.evidence_id} in the Evidence bundle`,
    });
    if (!headroom.ok) return headroom;
    const parsedCapture = safeParseProcessCapture(record.normalized_result);
    if (!parsedCapture.success) {
      const detail = boundedValidationFailure(parsedCapture.error, {
        budgetBytes: Math.max(0, EVIDENCE_CONTENT_ISSUE_BUDGET_BYTES - 1024),
        descriptionCopies: 2,
      }).description;
      return err(
        new EvidenceIntegrityError("Evidence bundle validation failed", {
          cause: parsedCapture.error,
          userMessage: `Process capture record ${record.evidence_id} has an invalid normalized_result (${detail}). Recreate or re-export the bundle, then try again.`,
        }),
      );
    }
  }
  return ok(undefined);
};

/** Atomically write deterministic evidence JSON at the caller-supplied path. */
export const writeEvidenceBundle = async (
  bundle: EvidenceBundle,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
  operation = "export_evidence_bundle",
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    EvidenceBundleFileFailure
  >
> => {
  if (signal?.aborted === true) return err(cancelledBy(operation, signal));
  if (!isImmutableEvidenceBundle(bundle)) {
    const issue = jsonValueValidationIssue(bundle);
    if (issue !== undefined)
      return err(
        new EvidenceIntegrityError("Evidence checkpoint is not ordinary JSON", {
          userMessage: issue,
        }),
      );
    const headroom = requireAuthenticationHeadroom(bundle, {
      operation,
      path: absoluteCallerPath(path),
      description:
        "Insufficient heap headroom to authenticate the Evidence checkpoint",
    });
    if (!headroom.ok) return headroom;
  }
  const checked = safeParseEvidenceBundle(bundle);
  if (!checked.ok) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause: checked.error.cause,
      }),
    );
  }
  const validated = validateBundlePayloads(checked.value, path, operation);
  if (!validated.ok) return validated;
  return writeTextParts(
    bufferedJsonParts(canonicalJsonParts(validated.value)),
    path,
    overwrite,
    resources,
    signal === undefined ? undefined : { signal, operation },
  );
};

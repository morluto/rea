import {
  createImmutableEvidenceBundle,
  describeEvidenceBundleFailure,
  describeValidationFailure,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  AnalysisCancelledError,
  type AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { parseProcessCapture } from "../domain/process/processCaptureParsing.js";
import {
  bufferedJsonParts,
  canonicalJsonParts,
} from "../domain/jsonSerialization.js";
import { readJsonFile, writeTextParts } from "./JsonFiles.js";
import { RegularFileCleanupFailure } from "./RegularFileRead.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

type EvidenceReadFailure =
  | EvidenceFileError
  | EvidenceIntegrityError
  | AnalysisResourceConstraintError
  | AnalysisCancelledError;
type EvidenceWriteFailure =
  | EvidenceFileError
  | EvidenceIntegrityError
  | AnalysisCancelledError;

/** Read and validate an evidence bundle at the caller-supplied path. */
export const readEvidenceBundle = (
  path: string,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> =>
  readBundle(path, parseEvidenceBundle);

/** Read an authenticated immutable snapshot for a subsequent session import. */
export const readImmutableEvidenceBundle = (
  path: string,
  signal?: AbortSignal,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> =>
  readBundle(
    path,
    (input) => {
      const bundle = parseEvidenceBundle(input);
      return createImmutableEvidenceBundle(bundle.records, bundle.unknowns);
    },
    signal,
  );

const readBundle = async (
  path: string,
  parseBundle: (input: unknown) => EvidenceBundle,
  signal?: AbortSignal,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> => {
  if (signal?.aborted)
    return err(new AnalysisCancelledError("import_evidence_bundle"));
  const loaded = await readJsonFile(path, signal).catch((cause: unknown) => {
    // A failed close transfers a live handle owner; preserve that failure.
    if (
      signal?.aborted === true &&
      !(cause instanceof RegularFileCleanupFailure)
    )
      return err(
        new AnalysisCancelledError("import_evidence_bundle", { cause }),
      );
    throw cause;
  });
  if (!loaded.ok) return loaded;
  if (signal?.aborted)
    return err(new AnalysisCancelledError("import_evidence_bundle"));
  let bundle: EvidenceBundle;
  try {
    bundle = parseBundle(loaded.value);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause,
        userMessage: describeEvidenceBundleFailure(loaded.value, cause),
      }),
    );
  }
  for (const record of bundle.records) {
    if (record.predicate_type !== "rea.process-capture") continue;
    try {
      parseProcessCapture(record.normalized_result);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Evidence bundle validation failed", {
          cause,
          userMessage: `Process capture record ${record.evidence_id} has an invalid normalized_result (${describeValidationFailure(cause)}). Recreate or re-export the bundle, then try again.`,
        }),
      );
    }
  }
  return ok(bundle);
};

/** Atomically write deterministic evidence JSON at the caller-supplied path. */
export const writeEvidenceBundle = async (
  bundle: EvidenceBundle,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    EvidenceWriteFailure
  >
> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError("export_evidence_bundle"));
  let checked: EvidenceBundle;
  try {
    checked = parseEvidenceBundle(bundle);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause,
      }),
    );
  }
  return writeTextParts(
    bufferedJsonParts(canonicalJsonParts(checked)),
    path,
    overwrite,
    resources,
    signal === undefined
      ? undefined
      : { signal, operation: "export_evidence_bundle" },
  );
};

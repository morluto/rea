import {
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

type EvidenceReadFailure =
  | EvidenceFileError
  | EvidenceIntegrityError
  | AnalysisResourceConstraintError;
type EvidenceWriteFailure =
  | EvidenceFileError
  | EvidenceIntegrityError
  | AnalysisCancelledError;

/** Read and validate an evidence bundle at the caller-supplied path. */
export const readEvidenceBundle = async (
  path: string,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> => {
  const loaded = await readJsonFile(path);
  if (!loaded.ok) return loaded;
  let bundle: EvidenceBundle;
  try {
    bundle = parseEvidenceBundle(loaded.value);
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
    signal === undefined
      ? undefined
      : { signal, operation: "export_evidence_bundle" },
  );
};

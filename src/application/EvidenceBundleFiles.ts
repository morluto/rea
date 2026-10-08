import {
  describeEvidenceBundleFailure,
  describeValidationFailure,
  parseEvidenceBundle,
  serializeEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseProcessCapture } from "../domain/process/processCapture.js";
import { readJsonFile, writeTextFile } from "./JsonFiles.js";

type EvidenceReadFailure = EvidenceFileError | EvidenceIntegrityError;
type EvidenceWriteFailure = EvidenceFileError | EvidenceIntegrityError;

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
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    EvidenceWriteFailure
  >
> => {
  let encoded: string;
  try {
    encoded = serializeEvidenceBundle(bundle);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause,
      }),
    );
  }
  return writeTextFile(encoded, path, overwrite);
};

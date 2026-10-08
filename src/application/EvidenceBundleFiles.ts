import {
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseProcessCapture } from "../domain/process/processCapture.js";
import {
  bufferedJsonParts,
  canonicalJsonParts,
} from "../domain/jsonSerialization.js";
import { readJsonFile, writeTextParts } from "./JsonFiles.js";

type EvidenceReadFailure = EvidenceFileError | EvidenceIntegrityError;
type EvidenceWriteFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate an evidence bundle at the caller-supplied path. */
export const readEvidenceBundle = async (
  path: string,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> => {
  const loaded = await readJsonFile(path);
  if (!loaded.ok) return loaded;
  try {
    const bundle = parseEvidenceBundle(loaded.value);
    for (const record of bundle.records) {
      if (record.predicate_type === "rea.process-capture")
        parseProcessCapture(record.normalized_result);
    }
    return ok(bundle);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle validation failed", {
        cause,
      }),
    );
  }
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
  );
};

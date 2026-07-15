import {
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  type AnalysisSnapshot,
} from "../domain/analysisSnapshot.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { EvidenceFileError, EvidenceIntegrityError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { readBoundedJson, writeBoundedText } from "./BoundedJsonFiles.js";

type SnapshotFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate a bounded analysis snapshot inside an approved root. */
export const readAnalysisSnapshot = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<Result<AnalysisSnapshot, SnapshotFailure>> => {
  const loaded = await readBoundedJson(path, policy);
  if (!loaded.ok) return loaded;
  try {
    return ok(parseAnalysisSnapshot(loaded.value));
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause }),
    );
  }
};

/** Atomically write a deterministic analysis snapshot inside an approved root. */
export const writeAnalysisSnapshot = async (
  snapshot: AnalysisSnapshot,
  path: string,
  overwrite: boolean,
  policy: EvidenceFilePolicy,
): Promise<
  Result<{ readonly path: string; readonly bytes: number }, SnapshotFailure>
> => {
  let encoded: string;
  try {
    encoded = serializeAnalysisSnapshot(snapshot);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause }),
    );
  }
  return writeBoundedText(encoded, path, overwrite, policy);
};

const snapshotValidationMessage = (cause: unknown): string =>
  cause instanceof TypeError
    ? cause.message
    : "Analysis snapshot validation failed";

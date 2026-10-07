import {
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  type AnalysisSnapshot,
} from "../../domain/analysisSnapshot.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import { err, ok, type Result } from "../../domain/result.js";
import { readJsonFile, writeTextFile } from "../JsonFiles.js";

type SnapshotFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate an analysis snapshot from the caller's path. */
export const readAnalysisSnapshot = async (
  path: string,
): Promise<Result<AnalysisSnapshot, SnapshotFailure>> => {
  const loaded = await readJsonFile(path);
  if (!loaded.ok) return loaded;
  try {
    return ok(parseAnalysisSnapshot(loaded.value));
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause }),
    );
  }
};

/** Atomically write a deterministic analysis snapshot to the caller's path. */
export const writeAnalysisSnapshot = async (
  snapshot: AnalysisSnapshot,
  path: string,
  overwrite: boolean,
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
  return writeTextFile(encoded, path, overwrite);
};

const snapshotValidationMessage = (cause: unknown): string =>
  cause instanceof TypeError
    ? cause.message
    : "Analysis snapshot validation failed";

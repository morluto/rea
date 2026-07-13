import {
  parseEvidenceBundle,
  serializeEvidenceBundle,
  type EvidenceBundle,
  type EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import { EvidenceFileError, EvidenceIntegrityError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  parseProcessCapture,
} from "../domain/processCapture.js";
import { readBoundedJson, writeBoundedText } from "./BoundedJsonFiles.js";

type EvidenceReadFailure = EvidenceFileError | EvidenceIntegrityError;
type EvidenceWriteFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate a bounded evidence bundle inside an approved root. */
export const readEvidenceBundle = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<Result<EvidenceBundle, EvidenceReadFailure>> => {
  if (policy.roots.length === 0)
    return err(new EvidenceFileError("read", "disabled"));
  const loaded = await readBoundedJson(path, policy);
  if (!loaded.ok) return loaded;
  try {
    const bundle = parseEvidenceBundle(loaded.value);
    for (const record of bundle.records) {
      if (record.predicate_type === "rea.process-capture/v3")
        throw new TypeError(LEGACY_PROCESS_CAPTURE_MESSAGE);
      if (record.predicate_type === "rea.process-capture/v4")
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

/** Atomically write deterministic evidence JSON inside an approved root. */
export const writeEvidenceBundle = async (
  bundle: EvidenceBundle,
  path: string,
  overwrite: boolean,
  policy: EvidenceFilePolicy,
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    EvidenceWriteFailure
  >
> => {
  if (policy.roots.length === 0)
    return err(new EvidenceFileError("write", "disabled"));
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
  return writeBoundedText(encoded, path, overwrite, policy);
};

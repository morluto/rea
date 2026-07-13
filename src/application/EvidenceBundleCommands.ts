import {
  EvidenceIntegrityError,
  type AnalysisError,
} from "../domain/errors.js";
import type {
  EvidenceFilePolicy,
  EvidenceBundle,
} from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareBundles } from "../domain/bundleComparison.js";
import { EvidenceLedger } from "./EvidenceLedger.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "./EvidenceBundleFiles.js";

/** Validate and merge one bundle using the same bounded ledger as MCP. */
export const importEvidenceBundleCommand = async (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<Result<JsonValue, AnalysisError>> => {
  const loaded = await readEvidenceBundle(path, policy);
  if (!loaded.ok) return loaded;
  const ledger = createLedger();
  const imported = ledger.import(loaded.value);
  return imported.ok
    ? ok({ imported: imported.value, total: ledger.export().records.length })
    : imported;
};

/** Validate a source bundle and atomically export canonical bytes. */
export const exportEvidenceBundleCommand = async (
  sourcePath: string,
  outputPath: string,
  overwrite: boolean,
  policy: EvidenceFilePolicy,
): Promise<Result<JsonValue, AnalysisError>> => {
  const loaded = await readEvidenceBundle(sourcePath, policy);
  if (!loaded.ok) return loaded;
  return projectWrite(
    loaded.value,
    await writeEvidenceBundle(loaded.value, outputPath, overwrite, policy),
  );
};

/** Compare two validated canonical Evidence v2 bundles without session state. */
export const compareEvidenceBundlesCommand = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
  readonly offset: number;
  readonly limit: number;
  readonly policy: EvidenceFilePolicy;
}): Promise<Result<JsonValue, AnalysisError>> => {
  const [left, right] = await Promise.all([
    readEvidenceBundle(input.leftPath, input.policy),
    readEvidenceBundle(input.rightPath, input.policy),
  ]);
  if (!left.ok) return left;
  if (!right.ok) return right;
  try {
    return ok(
      jsonValueSchema.parse(
        compareBundles(left.value, right.value, [], input.offset, input.limit),
      ),
    );
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle comparison failed", {
        cause,
      }),
    );
  }
};

const createLedger = (): EvidenceLedger =>
  new EvidenceLedger({ maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 });

const projectWrite = (
  bundle: EvidenceBundle,
  written: Awaited<ReturnType<typeof writeEvidenceBundle>>,
): Result<JsonValue, AnalysisError> =>
  written.ok
    ? ok({
        path: written.value.path,
        bytes: written.value.bytes,
        records: bundle.records.length,
      })
    : err(written.error);

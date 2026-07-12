import type { AnalysisError } from "../domain/errors.js";
import type {
  EvidenceFilePolicy,
  EvidenceBundle,
} from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
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

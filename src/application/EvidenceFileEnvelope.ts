import { resemblesAnalysisSnapshot } from "../domain/analysisSnapshot.js";
import { EvidenceFileError } from "../domain/evidenceErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { isRecord } from "../kernel/isRecord.js";

/** Observe the already decoded file envelope before authenticating its contents. */
export const evidenceFileEnvelopeKind = (
  value: unknown,
): "evidence-bundle" | "analysis-snapshot" | "other" => {
  if (isRecord(value) && Object.hasOwn(value, "records"))
    return "evidence-bundle";
  return resemblesAnalysisSnapshot(value) ? "analysis-snapshot" : "other";
};

/** Use the same observed kind with recovery for the selected Evidence input. */
export const snapshotWrongEvidenceKind = (
  path: string,
  operation: string,
  expected: "bundle" | "record-or-bundle",
): EvidenceFileError => {
  const importing = operation === "import_evidence_bundle";
  const explanation =
    "This JSON appears to be an analysis snapshot. Its snapshot content has not been validated.";
  return new EvidenceFileError("read", "wrong-kind", {
    path: absoluteCallerPath(path),
    detectedKind: "analysis-snapshot",
    related: {
      operations: importing
        ? ["open_binary", "export_evidence_bundle"]
        : ["export_evidence_bundle"],
    },
    userMessage: importing
      ? `${explanation} To restore it, use a matching target, provider and analysis profile: call open_binary with snapshot_path set to this file to load the snapshot, and close_binary with snapshot_path to save updated state. Alternatively, supply a bundle from export_evidence_bundle.`
      : expected === "bundle"
        ? `${explanation} Supply a standalone Evidence bundle from export_evidence_bundle for this input.`
        : `${explanation} Supply a standalone Evidence record or bundle for this input. Use export_evidence_bundle to export a bundle from a session.`,
  });
};

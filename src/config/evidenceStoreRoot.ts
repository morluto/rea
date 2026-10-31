import { isAbsolute, join } from "node:path";

/**
 * Resolve the opt-in project store root from an already admitted environment.
 * Invalid explicit roots are rejected by configuration parsing; unvalidated
 * embedders get no store rather than a surprising relative path.
 */
export const projectEvidenceStoreRoot = (environment: {
  readonly REA_EVIDENCE_STORE?: string | undefined;
  readonly REA_EVIDENCE_STORE_DIR?: string | undefined;
}): string | undefined => {
  if (environment.REA_EVIDENCE_STORE !== "project") return undefined;
  const configured = environment.REA_EVIDENCE_STORE_DIR;
  if (configured === undefined) return join(process.cwd(), ".rea", "evidence");
  return isAbsolute(configured) ? configured : undefined;
};

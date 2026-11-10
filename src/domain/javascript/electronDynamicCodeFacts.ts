import type { ElectronDynamicCodeFinding } from "./electronStaticAnalysisTypes.js";

/** A source-only compilation cannot establish an opaque cache boundary. */
export const isPossibleCachedDataCompilation = (
  finding: ElectronDynamicCodeFinding,
): boolean => finding.cached_data_status !== "absent";

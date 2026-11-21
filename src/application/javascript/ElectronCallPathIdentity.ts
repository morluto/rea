import type { ElectronCallPath } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";

/** Keep wrapper-path identity source-scoped across both graph projections. */
export const electronCallPathId = (
  filePath: string,
  path: ElectronCallPath,
): string => digestCanonicalValue([filePath, path], "Electron call path");

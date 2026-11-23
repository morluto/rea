import { PeImportsService } from "../../application/binaryDiagnostics/PeImportsService.js";
import { PeImportsProvider } from "../../native/pe/PeImportsProvider.js";

/** Portable PE import-table inspection with no engine or catalog verification. */
export const createPeImportsService = (): PeImportsService =>
  new PeImportsService(new PeImportsProvider());

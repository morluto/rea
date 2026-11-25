import { electronFuseReportSchema } from "../../domain/electron/electronFuses.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Exact Evidence schema for read-only Electron fuse inspection. */
export const electronFuseOutputSchemas = {
  inspect_electron_fuses: evidenceResultOf(electronFuseReportSchema),
};

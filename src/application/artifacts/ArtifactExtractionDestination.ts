import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";

/** Preserve an explicit destination; otherwise choose a fresh temporary root. */
export const createArtifactExtractionDestination = (
  outputRoot?: string,
): string =>
  outputRoot ?? absoluteCallerPath(`${tmpdir()}/rea-extracted-${randomUUID()}`);

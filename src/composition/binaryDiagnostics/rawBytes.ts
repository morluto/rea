import { RawBytesService } from "../../application/binaryDiagnostics/RawBytesService.js";
import type { ArtifactResourceScope } from "../../resources/index.js";

/** Provider-free raw file offset reads and searches. */
export const createRawBytesService = (
  resources?: ArtifactResourceScope,
): RawBytesService => new RawBytesService(undefined, resources);

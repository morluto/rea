import { ByteEntropyService } from "../../application/binaryDiagnostics/ByteEntropyService.js";
import type { ArtifactResourceScope } from "../../resources/index.js";

/** Provider-free local byte analysis. */
export const createByteEntropyService = (
  resources?: ArtifactResourceScope,
): ByteEntropyService => new ByteEntropyService(undefined, resources);

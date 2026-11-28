import { LabviewArtifactService } from "../application/labview/LabviewArtifactService.js";
import { LabviewArtifactProvider } from "../labview/LabviewArtifactProvider.js";
import type { ArtifactResourceScope } from "../resources/index.js";

/** Compose bundled offline inspection without acquiring LabVIEW or starting a process. */
export const createLabviewArtifactService = (
  resources?: ArtifactResourceScope,
): LabviewArtifactService =>
  new LabviewArtifactService(new LabviewArtifactProvider(resources));

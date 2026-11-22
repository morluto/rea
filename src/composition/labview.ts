import { LabviewArtifactService } from "../application/labview/LabviewArtifactService.js";
import { LabviewArtifactProvider } from "../labview/LabviewArtifactProvider.js";

/** Compose bundled offline inspection without acquiring LabVIEW or starting a process. */
export const createLabviewArtifactService = (): LabviewArtifactService =>
  new LabviewArtifactService(new LabviewArtifactProvider());

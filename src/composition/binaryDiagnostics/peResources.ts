import { PeResourcesService } from "../../application/binaryDiagnostics/PeResourcesService.js";
import { PeResourcesProvider } from "../../native/pe/PeResourcesProvider.js";

/** Portable PE inspection with no engine, installation or target acquisition. */
export const createPeResourcesService = (): PeResourcesService =>
  new PeResourcesService(new PeResourcesProvider());

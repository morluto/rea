import { PeOverlayService } from "../../application/binaryDiagnostics/PeOverlayService.js";
import { PeOverlayProvider } from "../../native/pe/PeOverlayProvider.js";

/** Portable PE overlay inspection with no engine or signature verification. */
export const createPeOverlayService = (): PeOverlayService =>
  new PeOverlayService(new PeOverlayProvider());

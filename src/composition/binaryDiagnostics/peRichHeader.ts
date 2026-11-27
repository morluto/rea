import { PeRichHeaderService } from "../../application/binaryDiagnostics/PeRichHeaderService.js";
import { PeRichHeaderProvider } from "../../native/pe/PeRichHeaderProvider.js";

/** Portable PE Rich header inspection with no engine or Visual Studio installation. */
export const createPeRichHeaderService = (): PeRichHeaderService =>
  new PeRichHeaderService(new PeRichHeaderProvider());

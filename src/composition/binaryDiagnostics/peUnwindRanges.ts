import { PeUnwindRangesService } from "../../application/binaryDiagnostics/PeUnwindRangesService.js";
import { PeUnwindRangesProvider } from "../../native/pe/PeUnwindRangesProvider.js";

export const createPeUnwindRangesService = (): PeUnwindRangesService =>
  new PeUnwindRangesService(new PeUnwindRangesProvider());

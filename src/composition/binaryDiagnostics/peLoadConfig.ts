import { PeLoadConfigService } from "../../application/binaryDiagnostics/PeLoadConfigService.js";
import { PeLoadConfigProvider } from "../../native/pe/PeLoadConfigProvider.js";

export const createPeLoadConfigService = (): PeLoadConfigService =>
  new PeLoadConfigService(new PeLoadConfigProvider());

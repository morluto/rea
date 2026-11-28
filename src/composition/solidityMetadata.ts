import { SolidityMetadataBindingService } from "../application/evm/SolidityMetadataBindingService.js";
import { SolidityMetadataBindingProvider } from "../evm/SolidityMetadataBindingProvider.js";

/** Compose the portable metadata verifier without import-time I/O. */
export const createSolidityMetadataBindingService =
  (): SolidityMetadataBindingService =>
    new SolidityMetadataBindingService(new SolidityMetadataBindingProvider());

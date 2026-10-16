import { NeExecutableService } from "../../application/binaryDiagnostics/NeExecutableService.js";
import { NeExecutableProvider } from "../../native/ne/NeExecutableProvider.js";

/** Portable NE inspection with no engine, installation or target acquisition. */
export const createNeExecutableService = (): NeExecutableService =>
  new NeExecutableService(new NeExecutableProvider());

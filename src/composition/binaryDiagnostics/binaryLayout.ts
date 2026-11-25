import { BinaryLayoutService } from "../../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../../native/pwntools/PwntoolsLayoutProvider.js";
import {
  HOST_PLATFORM,
  type HostPlatform,
} from "../../platform/HostPlatform.js";

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  host: HostPlatform = HOST_PLATFORM,
): BinaryLayoutService =>
  new BinaryLayoutService(
    new PwntoolsLayoutProvider(environment, undefined, undefined, host),
  );

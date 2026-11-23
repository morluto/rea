import { RecordedCrashService } from "../../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../../native/pwntools/PwntoolsRecordedCrashProvider.js";
import {
  HOST_PLATFORM,
  type HostPlatform,
} from "../../platform/HostPlatform.js";

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  host: HostPlatform = HOST_PLATFORM,
): RecordedCrashService =>
  new RecordedCrashService(
    new PwntoolsRecordedCrashProvider(environment, undefined, undefined, host),
  );

import { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../native/pwntools/PwntoolsRecordedCrashProvider.js";
import { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../native/pwntools/PwntoolsLayoutProvider.js";

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryLayoutService =>
  new BinaryLayoutService(new PwntoolsLayoutProvider(environment));

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RecordedCrashService =>
  new RecordedCrashService(new PwntoolsRecordedCrashProvider(environment));

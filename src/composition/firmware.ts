import type { FirmwareAnalysisPort } from "../ports/firmware/FirmwareAnalysisPort.js";
import type { FirmwareLauncher } from "../firmware/FirmwareCommand.js";
import { FirmwareProvider } from "../firmware/FirmwareProvider.js";
import { HOST_PLATFORM, type HostPlatform } from "../platform/HostPlatform.js";

/** Construct one firmware provider without launching or acquiring an engine. */
export const createFirmwareAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: FirmwareLauncher,
  host: HostPlatform = HOST_PLATFORM,
): FirmwareAnalysisPort => new FirmwareProvider(environment, launcher, host);

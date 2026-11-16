import { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { SigrokRecordingProvider } from "../signals/SigrokRecordingProvider.js";

export const createSignalRecordingService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): SignalRecordingService =>
  new SignalRecordingService(
    new SigrokRecordingProvider(environment, undefined, undefined, platform),
  );

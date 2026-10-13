import { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import { SigrokRecordingProvider } from "../signals/SigrokRecordingProvider.js";
export const createSignalRecordingService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SignalRecordingService =>
  new SignalRecordingService(new SigrokRecordingProvider(environment));

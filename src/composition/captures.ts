import { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import { TsharkCaptureProvider } from "../captures/TsharkCaptureProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

export const createPacketCaptureService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): PacketCaptureService =>
  new PacketCaptureService(
    new TsharkCaptureProvider(environment, undefined, undefined, platform),
  );

import { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import { TsharkCaptureProvider } from "../captures/TsharkCaptureProvider.js";
export const createPacketCaptureService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): PacketCaptureService =>
  new PacketCaptureService(new TsharkCaptureProvider(environment));

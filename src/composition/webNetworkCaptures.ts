import { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import { HistoricalCaptureDecoder } from "../browser/history/HistoricalCaptureDecoder.js";
import { HarCaptureAdapter } from "../browser/history/HarCaptureAdapter.js";
import { MitmproxyCaptureAdapter } from "../browser/history/MitmproxyCaptureAdapter.js";

/** Compose offline format adapters without import-time reads, installation or process startup. */
export const createWebNetworkCaptureService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): WebNetworkCaptureService =>
  new WebNetworkCaptureService(
    new HistoricalCaptureDecoder(
      [new HarCaptureAdapter(), new MitmproxyCaptureAdapter(environment)],
      environment,
    ),
  );

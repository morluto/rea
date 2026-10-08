import { fileURLToPath } from "node:url";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import { HAR_CAPTURE_PROVIDER_IDENTITY } from "./CaptureRelease.js";

/** HAR's parser/schema packages run in one bounded Node heap, without network or target execution. */
export class HarCaptureAdapter implements HistoricalCaptureFormatAdapter {
  readonly format = "har";
  readonly identity = HAR_CAPTURE_PROVIDER_IDENTITY;
  async command(
    requestPath: string,
  ): Promise<{ command: string; arguments: readonly string[] }> {
    return {
      command: process.execPath,
      arguments: [
        "--max-old-space-size=192",
        "--max-semi-space-size=8",
        "--v8-pool-size=1",
        "--single-threaded",
        fileURLToPath(new URL("./HarCaptureProcess.js", import.meta.url)),
        requestPath,
      ],
    };
  }
}

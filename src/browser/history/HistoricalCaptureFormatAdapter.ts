import type { InspectWebNetworkCaptureInput } from "../../domain/webNetworkCapture.js";

/** Format-specific process profile keeps mature upstream code behind a replaceable adapter seam. */
export interface HistoricalCaptureFormatAdapter {
  readonly format: InspectWebNetworkCaptureInput["format"];
  readonly limitations?: readonly string[];
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
  /** `memoryLimitBytes` requests an enforced commit limit for the decoder process tree. */
  command(
    requestPath: string,
    runtimePath: string,
  ): Promise<{
    command: string;
    arguments: readonly string[];
    memoryLimitBytes?: number;
  }>;
}

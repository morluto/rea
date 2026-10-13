import { fileURLToPath } from "node:url";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import {
  NODE_CAPTURE_HEAP_ENFORCED,
  HAR_CAPTURE_PROVIDER_IDENTITY,
  SAZ_CAPTURE_PROVIDER_IDENTITY,
  QLOG_CAPTURE_PROVIDER_IDENTITY,
  NODE_CAPTURE_HEAP_LIMITS,
  NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES,
} from "./CaptureRelease.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";

/** Package-backed capture decoders share one bounded offline Node process profile. */
export class NodeCaptureAdapter implements HistoricalCaptureFormatAdapter {
  readonly identity;
  readonly limitations;
  constructor(readonly format: "har" | "saz" | "qlog") {
    this.identity =
      format === "har"
        ? HAR_CAPTURE_PROVIDER_IDENTITY
        : format === "saz"
          ? SAZ_CAPTURE_PROVIDER_IDENTITY
          : QLOG_CAPTURE_PROVIDER_IDENTITY;
    this.limitations =
      format === "saz"
        ? [
            "SAZ ordinals follow first session-member occurrence in ZIP directory order, not chronology or numeric session ID.",
            "HTTP fields use byte-preserving Latin-1 text; start-line separators and header delimiters are not projected. Bodies retain stored bytes without transfer/content decoding. Absent members are null, distinct from empty bodies.",
            "XML preserves node order and attribute/text values, not its original byte serialization. WebSocket and gRPC members retain opaque message-file bytes, not decoded protocol events.",
            "Non-session archive members are inventoried but their content is not decoded.",
          ]
        : [];
  }
  async command(requestPath: string) {
    if (
      this.format !== "har" &&
      !NODE_CAPTURE_HEAP_ENFORCED &&
      NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES === null
    )
      throw new AnalysisCapabilityUnavailableError(
        this.identity.id,
        "inspect_web_network_capture",
        `${this.format} decoding requires an enforced decoder memory limit. Run REA with Node.js on this host.`,
      );
    return {
      command: process.execPath,
      arguments: [
        `--max-old-space-size=${NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB}`,
        `--max-semi-space-size=${NODE_CAPTURE_HEAP_LIMITS.semiSpaceMiB}`,
        "--v8-pool-size=1",
        "--single-threaded",
        fileURLToPath(new URL("./NodeCaptureProcess.js", import.meta.url)),
        requestPath,
        this.format,
      ],
      ...(NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES === null
        ? {}
        : { memoryLimitBytes: NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES }),
    };
  }
}

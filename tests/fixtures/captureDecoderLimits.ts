import {
  captureDecoderProcessMemoryLimitBytes,
  NODE_CAPTURE_HEAP_LIMITS,
} from "../../src/browser/history/CaptureRelease.js";

/** Default Job Object limit used by capture decoder fixtures. */
export const NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES =
  captureDecoderProcessMemoryLimitBytes(
    NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB,
  );

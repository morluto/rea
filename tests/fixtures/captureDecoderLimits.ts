import { javaScriptWorkerMemoryLimitBytes } from "../../src/process/JavaScriptWorkerMemoryLimit.js";
import { DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB } from "../../src/domain/analysisResourceLimits.js";
import { NODE_CAPTURE_HEAP_ENFORCED } from "../../src/browser/history/CaptureRelease.js";
import {
  javaScriptRuntime,
  supportsJavaScriptRuntime,
} from "../../src/domain/runtimeVersion.js";

/** Default Job Object limit used by capture decoder fixtures. */
export const NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES =
  javaScriptWorkerMemoryLimitBytes(DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB);

export const CAPTURE_RUNTIME_SUPPORTED = supportsJavaScriptRuntime(
  javaScriptRuntime(process.versions),
);

export const CAPTURE_DECODER_HAS_MEMORY_BOUND =
  NODE_CAPTURE_HEAP_ENFORCED ||
  NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES !== null;

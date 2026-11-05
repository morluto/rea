import {
  CAPTURE_DECODER_SEMI_SPACE_MIB,
  DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB,
} from "../../domain/analysisResourceLimits.js";
import { javaScriptRuntime } from "../../domain/runtimeVersion.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../process/JavaScriptWorkerMemoryLimit.js";

/**
 * Default V8 heap settings for the owned Node capture decoder process.
 * The old generation is `REA_CAPTURE_DECODER_OLD_GENERATION_MIB`; the
 * semi-space stays fixed.
 */
export const NODE_CAPTURE_HEAP_LIMITS = {
  oldGenerationMiB: DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB,
  semiSpaceMiB: CAPTURE_DECODER_SEMI_SPACE_MIB,
} as const;

/** Windows Job Object commit limit for one resolved old-generation budget. */
export const captureDecoderProcessMemoryLimitBytes = (
  oldGenerationMiB: number,
): number | null => javaScriptWorkerMemoryLimitBytes(oldGenerationMiB);

/** The Node capture decoder runs on this executable; Bun accepts but ignores V8 heap flags. */
export const NODE_CAPTURE_HEAP_ENFORCED =
  javaScriptRuntime(process.versions).id === "node";

/** Commit limit for the default heap. A configured heap uses `captureDecoderProcessMemoryLimitBytes`. */
export const NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES =
  captureDecoderProcessMemoryLimitBytes(
    NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB,
  );

/** Fixed offline interpretation profile, not an authenticated producer claim. */

import type { Result } from "../result.js";

/** A whole-file refusal from a firmware decoder; no partial regions accompany it. */
export interface RegionDecodeFailure {
  readonly kind: "malformed" | "limit" | "unsupported";
  readonly message: string;
  readonly boundary?: "file-size" | "capacity";
  /**
   * Format-specific ceiling id. The owning reader maps it to a registered
   * fixed allowance. Absent, a limit refusal stays a generic fixed-limit failure.
   */
  readonly ceiling?: string;
}

/** A streaming firmware decoder, fed the admitted file bytes in order. */
export interface RegionDecoder<Image> {
  write(chunk: Uint8Array): Result<void, RegionDecodeFailure>;
  finish(): Result<Image, RegionDecodeFailure>;
}

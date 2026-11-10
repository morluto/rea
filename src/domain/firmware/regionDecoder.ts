import type { Result } from "../result.js";

/** Launch-setting ceiling carried by a whole-file limit refusal. */
export interface RegionFileAdmissionLimit {
  readonly code: string;
  readonly setting: string;
  readonly fileBytes: number | null;
  readonly maximumBytes: number;
  readonly source: "default" | "setting";
  readonly defaultBytes: number;
  readonly floorBytes: number;
  readonly maximumSettingBytes: number;
  readonly restartRequired: true;
}

/** A whole-file refusal from a firmware decoder; no partial regions accompany it. */
export interface RegionDecodeFailure {
  readonly kind: "format" | "limit";
  readonly message: string;
  readonly boundary?: "file-size" | "capacity";
  readonly fileAdmission?: RegionFileAdmissionLimit;
}

/** A streaming firmware decoder, fed the admitted file bytes in order. */
export interface RegionDecoder<Image> {
  write(chunk: Uint8Array): Result<void, RegionDecodeFailure>;
  finish(): Result<Image, RegionDecodeFailure>;
}

import type { Result } from "../result.js";

/** Whole-file ceiling carried by a limit refusal. The reader names the runtime setting. */
export interface RegionFileAdmissionLimit {
  readonly code: string;
  readonly setting: string;
  readonly fileBytes: number | null;
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
  readonly defaultBytes: number;
  readonly floorBytes: number;
  readonly maximumSettingBytes: number;
  readonly updateMode: "runtime";
  readonly pendingRestart: false;
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

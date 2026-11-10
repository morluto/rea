import { z } from "zod";
import { constants as bufferConstants } from "node:buffer";

/** Defaults are shared with bridge configuration and partial-read admission. */
export const NATIVE_CALL_CAPTURE_DEFAULTS = {
  trace_bytes: 8 * 1024 * 1024,
  trace_frames: 65_536,
  breakpoint_location_bytes: 8 * 1024 * 1024,
  other_stops: 256,
  selector_bytes: 1024,
  output_bytes: 1024 * 1024,
} as const;

/** Captures are read as bounded Buffers and decoded to a single string. */
export const MAX_NATIVE_CALL_CAPTURE_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
);
const bytes = z.int().min(1).max(MAX_NATIVE_CALL_CAPTURE_BYTES);
const count = z.int().min(1);

/** Retention choices apply before the owned observation starts. */
export const nativeCallCaptureLimitsSchema = z.strictObject({
  trace_bytes: bytes.default(NATIVE_CALL_CAPTURE_DEFAULTS.trace_bytes),
  trace_frames: count.default(NATIVE_CALL_CAPTURE_DEFAULTS.trace_frames),
  breakpoint_location_bytes: bytes.default(
    NATIVE_CALL_CAPTURE_DEFAULTS.breakpoint_location_bytes,
  ),
  other_stops: count.default(NATIVE_CALL_CAPTURE_DEFAULTS.other_stops),
  selector_bytes: bytes.default(NATIVE_CALL_CAPTURE_DEFAULTS.selector_bytes),
  output_bytes: bytes.default(NATIVE_CALL_CAPTURE_DEFAULTS.output_bytes),
});

/** Preserve caller omission separately from effective capture policy. */
export const nativeCallCaptureLimitsInputSchema = z.strictObject({
  trace_bytes: nativeCallCaptureLimitsSchema.shape.trace_bytes
    .removeDefault()
    .optional(),
  trace_frames: nativeCallCaptureLimitsSchema.shape.trace_frames
    .removeDefault()
    .optional(),
  breakpoint_location_bytes:
    nativeCallCaptureLimitsSchema.shape.breakpoint_location_bytes
      .removeDefault()
      .optional(),
  other_stops: nativeCallCaptureLimitsSchema.shape.other_stops
    .removeDefault()
    .optional(),
  selector_bytes: nativeCallCaptureLimitsSchema.shape.selector_bytes
    .removeDefault()
    .optional(),
  output_bytes: nativeCallCaptureLimitsSchema.shape.output_bytes
    .removeDefault()
    .optional(),
});

export type NativeCallCaptureLimits = z.output<
  typeof nativeCallCaptureLimitsSchema
>;

export const nativeCallCaptureLimits = (
  selected?: z.input<typeof nativeCallCaptureLimitsSchema>,
): NativeCallCaptureLimits =>
  nativeCallCaptureLimitsSchema.parse(selected ?? {});

import { z } from "zod";
import type { UnverifiedProcessCapture } from "./processCapture.js";
import type { ProcessObservationSource } from "./processObservation.js";

const byteRetentionSchema = z.strictObject({
  budget_bytes: z.number().int().nonnegative(),
  observed_bytes: z.number().int().nonnegative(),
  retained_bytes: z.number().int().nonnegative(),
  observed_frames: z.number().int().nonnegative(),
  retained_frames: z.number().int().nonnegative(),
});

/** Filesystem enumeration and whole-file digest coverage for one checkpoint. */
export const filesystemCoverageSchema = z.strictObject({
  files_limit: z.number().int().nonnegative(),
  depth_limit: z.number().int().nonnegative(),
  enumeration_truncated: z.boolean(),
  enumeration_reasons: z.array(
    z.enum(["files_limit", "depth_limit", "identity_changed"]),
  ),
  hash_budget_bytes: z.number().int().nonnegative(),
  hashed_bytes: z.number().int().nonnegative(),
  hash_omissions: z.array(
    z.strictObject({
      path: z.string(),
      size_bytes: z.number().int().nonnegative(),
      remaining_budget_bytes: z.number().int().nonnegative(),
      reason: z.enum(["file_bytes_budget", "file_changed_or_short_read"]),
    }),
  ),
});
export type FilesystemCoverage = z.infer<typeof filesystemCoverageSchema>;

/** Actual budget accounting; rendered bytes count state and visible lines, not JSON. */
export const processCaptureTruncationDetailsSchema = z.strictObject({
  raw_terminal: byteRetentionSchema.describe(
    "UTF-8 bytes of original PTY chunks; whole chunks are retained or omitted.",
  ),
  rendered_terminal: byteRetentionSchema.describe(
    "Cumulative UTF-8 bytes of serialized state plus visible lines, evaluated from retained PTY input; whole frames are retained or omitted.",
  ),
  filesystem_before: filesystemCoverageSchema,
  filesystem_after: filesystemCoverageSchema,
  process: z.strictObject({
    sample_limit: z.number().int().nonnegative(),
    sampling_partial: z.boolean(),
    retained_samples: z.number().int().nonnegative(),
    sample_limit_reached: z.boolean(),
    sampling_failures: z.number().int().nonnegative(),
    first_sampling_failure: z.string().nullable(),
    coverage: z.literal("sampled"),
  }),
});
export type ProcessCaptureTruncationDetails = z.infer<
  typeof processCaptureTruncationDetailsSchema
>;
export type TerminalRetention = ProcessCaptureTruncationDetails["raw_terminal"];
export type ProcessSamplingCoverage =
  ProcessCaptureTruncationDetails["process"];

const omitted = (retention: TerminalRetention): boolean =>
  retention.observed_frames > retention.retained_frames;
const filesystemTruncated = (coverage: FilesystemCoverage): boolean =>
  coverage.enumeration_truncated || coverage.hash_omissions.length > 0;

/** Derive the legacy aggregate flag from independent producer observations. */
export const hasCaptureTruncation = (
  details: ProcessCaptureTruncationDetails,
): boolean =>
  omitted(details.raw_terminal) ||
  omitted(details.rendered_terminal) ||
  filesystemTruncated(details.filesystem_before) ||
  filesystemTruncated(details.filesystem_after) ||
  details.process.sampling_partial;

/** Older truncated captures lack enough information to localize missing observations. */
export const processSourceTruncated = (
  capture: UnverifiedProcessCapture,
  source: ProcessObservationSource,
): boolean => {
  const details = capture.truncation_details;
  if (details === undefined) return capture.truncated;
  switch (source) {
    case "terminal_raw":
      return omitted(details.raw_terminal);
    case "terminal_rendered":
      return (
        omitted(details.raw_terminal) || omitted(details.rendered_terminal)
      );
    case "filesystem":
      return (
        filesystemTruncated(details.filesystem_before) ||
        filesystemTruncated(details.filesystem_after)
      );
    case "process":
      return details.process.sampling_partial;
    case "interaction":
    case "lifecycle":
      return false;
  }
};

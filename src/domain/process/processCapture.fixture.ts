import { compareProcessCaptures } from "./processComparison.js";
import { parseProcessCapture } from "./processCaptureParsing.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";
import { hasCaptureTruncation } from "./processCaptureCoverage.js";

import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";
/** Parse a detached valid empty capture for tests that need trusted evidence. */
export const emptyProcessCapture = () =>
  parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);

/** Parse a mutable unverified capture for boundary-validation tests. */
export const emptyUnverifiedProcessCapture = (): UnverifiedProcessCapture =>
  processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);

/** Account for every observation retained by a fully observed test fixture. */
export const accountFullyObservedProcessCapture = (
  capture: UnverifiedProcessCapture,
): UnverifiedProcessCapture => {
  const rawBytes = capture.frames.reduce(
    (total, frame) => total + Buffer.byteLength(frame.raw_data ?? frame.data),
    0,
  );
  const renderedBytes = capture.rendered_frames.reduce(
    (total, frame) =>
      frame.lines.reduce(
        (sum, line) => sum + Buffer.byteLength(line),
        total + Buffer.byteLength(frame.serialized_state),
      ),
    0,
  );
  const filesystemBefore = {
    ...capture.truncation_details.filesystem_before,
    hashed_bytes: capture.files_before
      .filter((file) => file.type === "file" && file.sha256 !== null)
      .reduce((total, file) => total + file.size, 0),
  };
  const filesystemAfter = {
    ...capture.truncation_details.filesystem_after,
    hashed_bytes: capture.files_after
      .filter((file) => file.type === "file" && file.sha256 !== null)
      .reduce((total, file) => total + file.size, 0),
  };
  const truncationDetails = {
    ...capture.truncation_details,
    raw_terminal: {
      ...capture.truncation_details.raw_terminal,
      observed_bytes: rawBytes,
      retained_bytes: rawBytes,
      observed_frames: capture.frames.length,
      retained_frames: capture.frames.length,
    },
    rendered_terminal: {
      ...capture.truncation_details.rendered_terminal,
      observed_bytes: renderedBytes,
      retained_bytes: renderedBytes,
      observed_frames: capture.rendered_frames.length,
      retained_frames: capture.rendered_frames.length,
    },
    filesystem_before: filesystemBefore,
    filesystem_after: filesystemAfter,
    process: {
      ...capture.truncation_details.process,
      sample_limit: Math.max(
        capture.truncation_details.process.sample_limit,
        capture.process_samples.length,
      ),
      retained_samples: capture.process_samples.length,
    },
  };
  const filesystemCheckpoints = capture.filesystem_checkpoints.map(
    (checkpoint, index) => {
      const coverage = index === 0 ? filesystemBefore : filesystemAfter;
      return {
        ...checkpoint,
        truncated:
          coverage.enumeration_truncated || coverage.hash_omissions.length > 0,
      };
    },
  );
  return {
    ...capture,
    filesystem_checkpoints: filesystemCheckpoints,
    truncation_details: truncationDetails,
    truncated: hasCaptureTruncation(truncationDetails),
  };
};

/** Project validation failures without coupling tests to Zod internals. */
export const processCaptureIssues = (
  capture: UnverifiedProcessCapture,
): readonly { readonly path: string; readonly message: string }[] => {
  const parsed = processCaptureSchema.safeParse(capture);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
};

/** Compare unverified fixture values through the production parser. */
export const compareUnverifiedProcessCaptures = (
  left: UnverifiedProcessCapture,
  right: UnverifiedProcessCapture,
  options?: Parameters<typeof compareProcessCaptures>[2],
): ReturnType<typeof compareProcessCaptures> =>
  compareProcessCaptures(
    parseProcessCapture(left),
    parseProcessCapture(right),
    options,
  );

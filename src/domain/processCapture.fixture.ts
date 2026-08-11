import {
  compareProcessCaptures,
  parseProcessCapture,
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";

export { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";

/** Parse a detached valid empty capture for tests that need trusted evidence. */
export const emptyProcessCapture = () =>
  parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);

/** Parse a mutable unverified capture for boundary-validation tests. */
export const emptyUnverifiedProcessCapture = (): UnverifiedProcessCapture =>
  processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);

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

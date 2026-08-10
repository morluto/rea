import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../src/contracts/processCaptureExample.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "../../src/domain/processCapture.js";

export const emptyProcessCapture = () =>
  parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);

export const emptyUnverifiedProcessCapture = (): UnverifiedProcessCapture =>
  processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);

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

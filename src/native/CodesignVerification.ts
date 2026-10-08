import type { InspectSignature } from "../domain/native/nativeInspection.js";
import type { NativeCommandCapture } from "./CommandRunner.js";

/** Strip the diagnostic's echoed pathname for classification, keeping the raw line elsewhere. */
export const codesignReason = (line: string, path: string): string => {
  if (line.startsWith(`${path}: `)) return line.slice(path.length + 2);
  if (line.startsWith("/") || line.startsWith(`${path}/`)) {
    const delimiter = line.lastIndexOf(": ");
    return delimiter >= 0 ? line.slice(delimiter + 2) : "";
  }
  return line;
};

/** Remove the complete selected path before splitting lines, including embedded LF bytes. */
export const codesignReasons = (
  capture: NativeCommandCapture,
  path: string,
): string[] => {
  const observed = `${capture.stderr}\n${capture.stdout}`;
  const text =
    path.length === 0 ? observed : observed.split(path).join("$SELECTED_PATH");
  const lines = text.split("\n");
  const progress = lines.some((line) =>
    /^--(?:prepared|validated):/u.test(line),
  );
  return (
    lines
      .filter((line) => !/^--(?:prepared|validated):/u.test(line))
      // Unprefixed continuation text can belong to an unescaped nested filename.
      // Keep it as raw evidence, but do not turn it into a verification reason.
      .filter(
        (line) =>
          !progress ||
          line.startsWith("$SELECTED_PATH: ") ||
          line.startsWith("$SELECTED_PATH/"),
      )
      .map((line) => codesignReason(line, "$SELECTED_PATH"))
  );
};

/** Classify only explicit diagnostic reasons; nonzero exit alone proves no invalidity. */
const operationalReason = (reason: string): boolean =>
  /^(?:permission denied|operation not permitted|EACCES\b|EPERM\b|I\/O error|input\/output error)/iu.test(
    reason,
  );

/**
 * Definitive codesign rejections. A nonzero exit whose text is not in this
 * list, and is not an operational failure, stays `unknown` so an unrecognized
 * diagnostic is not reported as a broken signature.
 */
const INVALID_SIGNATURE_REASONS = [
  "a resource envelope is obsolete",
  "a sealed resource is missing or invalid",
  "bundle format unrecognized, invalid, or unsuitable",
  "code or signature modified",
  "file added:",
  "file modified:",
  "invalid or unsupported format",
  "invalid signature",
  "resource envelope is obsolete",
  "resource fork, Finder information, or similar detritus not allowed",
  "signature is invalid",
  "unsealed contents present",
] as const;

const invalidSignatureReason = (reason: string): boolean => {
  const text = reason.toLowerCase();
  return INVALID_SIGNATURE_REASONS.some((phrase) =>
    text.startsWith(phrase.toLowerCase()),
  );
};

/** Operational diagnostics can coexist with an independently proven invalid component. */
export const codesignOperationalFailure = (
  capture: NativeCommandCapture,
  path: string,
): boolean => codesignReasons(capture, path).some(operationalReason);

const verificationStatus = (
  capture: NativeCommandCapture,
  reasons: readonly string[],
  unsigned: boolean,
): NonNullable<InspectSignature["verification"]>["status"] => {
  if (capture.exitCode === 0) return "valid";
  const unsignedReason = reasons.some((reason) =>
    /^(?:code object is not signed at all|code object is not signed|not signed at all)/iu.test(
      reason,
    ),
  );
  if (reasons.some(invalidSignatureReason)) return "invalid";
  if (unsignedReason && !unsigned) return "invalid";
  if (reasons.some(operationalReason)) return "unknown";
  if (unsignedReason) return "unsigned";
  return "unknown";
};

/** Project codesign verification without changing pathname bytes or discarding diagnostics. */
export const signatureVerification = (
  capture: NativeCommandCapture,
  path: string,
  unsigned: boolean,
): NonNullable<InspectSignature["verification"]> => {
  const lines = `${capture.stderr}\n${capture.stdout}`
    .split("\n")
    .filter((line) => line.length > 0);
  const diagnostics = lines.filter(
    (line) => !/^--(?:prepared|validated):/u.test(line),
  );
  return {
    path,
    status: verificationStatus(
      capture,
      codesignReasons(capture, path),
      unsigned,
    ),
    exit_code: capture.exitCode,
    diagnostics,
    prepared_nested_code: [
      ...new Set(
        lines.flatMap((line) =>
          line.startsWith("--prepared:")
            ? [line.slice("--prepared:".length)]
            : [],
        ),
      ),
    ].sort(),
    raw_stdout: capture.stdout,
    raw_stderr: capture.stderr,
    validated_nested_code: [
      ...new Set(
        lines.flatMap((line) =>
          line.startsWith("--validated:")
            ? [line.slice("--validated:".length)]
            : [],
        ),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
};

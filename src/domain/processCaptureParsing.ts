import {
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";

declare class ProcessCaptureProof {
  private readonly verified: never;
}

/** Semantically verified Process Capture v4 value. */
export type ProcessCapture = UnverifiedProcessCapture & ProcessCaptureProof;

const verifiedCaptures = new WeakSet<UnverifiedProcessCapture>();

const isVerifiedCapture = (
  capture: UnverifiedProcessCapture,
): capture is ProcessCapture => verifiedCaptures.has(capture);

const attachProof = (capture: UnverifiedProcessCapture): ProcessCapture => {
  verifiedCaptures.add(capture);
  if (isVerifiedCapture(capture)) return capture;
  throw new TypeError("Process Capture proof ownership failed");
};

/** Parse unknown input as v4 and reject invalid commitments or semantics. */
export const parseProcessCapture = (input: unknown): ProcessCapture => {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    input.schema_version === 3
  )
    throw new TypeError(LEGACY_PROCESS_CAPTURE_MESSAGE);
  const parsed = processCaptureSchema.safeParse(input);
  if (parsed.success) return attachProof(parsed.data);
  const issues = parsed.error.issues.flatMap((issue) =>
    issue.code === "custom"
      ? [{ path: issue.path.join("."), message: issue.message }]
      : [],
  );
  if (issues.length > 0)
    throw new TypeError(
      `Invalid Process Capture v4: ${issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
    );
  throw parsed.error;
};

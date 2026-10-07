import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";

declare class ProcessCaptureProof {
  private readonly verified: never;
}

/** Semantically verified process capture value. */
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

/** Parse unknown input and reject invalid commitments or semantics. */
export const parseProcessCapture = (input: unknown): ProcessCapture => {
  const parsed = processCaptureSchema.safeParse(input);
  if (parsed.success) return attachProof(parsed.data);
  const issues = parsed.error.issues.flatMap((issue) =>
    issue.code === "custom"
      ? [{ path: issue.path.join("."), message: issue.message }]
      : [],
  );
  if (issues.length > 0)
    throw new TypeError(
      `Invalid process capture: ${issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
    );
  throw parsed.error;
};

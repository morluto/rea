import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";
import { z } from "zod";

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

const recordSchema = z.record(z.string(), z.unknown());
const LEGACY_EXECUTABLE_IDENTITY_REASON =
  "Legacy v3 capture did not distinguish selected and launch executable digests";

const migrateLegacyV3Capture = (input: unknown): unknown => {
  const capture = recordSchema.safeParse(input);
  if (!capture.success) return input;
  const manifest = recordSchema.safeParse(capture.data.manifest);
  if (!manifest.success) return input;
  if (
    manifest.data.provider_version !== "3" ||
    "selected_executable_sha256" in manifest.data ||
    "executable_identity" in manifest.data ||
    "legacy_executable_sha256" in manifest.data
  )
    return input;

  const { executable_sha256 } = manifest.data;
  if (
    typeof executable_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(executable_sha256)
  )
    return input;
  return {
    ...capture.data,
    manifest: {
      ...manifest.data,
      selected_executable_sha256: null,
      executable_sha256: null,
      executable_identity: {
        state: "unknown",
        reason: LEGACY_EXECUTABLE_IDENTITY_REASON,
      },
      legacy_executable_sha256: executable_sha256,
    },
  };
};

/** Parse unknown input and reject invalid commitments or semantics. */
export const parseProcessCapture = (input: unknown): ProcessCapture => {
  const parsed = processCaptureSchema.safeParse(migrateLegacyV3Capture(input));
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

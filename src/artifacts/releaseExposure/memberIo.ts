import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { cancelledBy } from "../../domain/analysisErrorCore.js";
import type { ArtifactIntegrityCheck } from "../../domain/artifactOperationError.js";
import { MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES } from "../../domain/releaseExposure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { readFileHandleRange } from "../../filesystem/readFileHandleRange.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  openRootArtifact,
  readStableArtifact,
  releaseRootArtifact,
} from "../../resources/index.js";
import { RELEASE_EXPOSURE_AUDIT_OPERATION as OPERATION } from "./releaseExposureFailures.js";

/** One read attempt. Allowance and read failure are different facts. */
export type MemberRead =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "over_allowance"; readonly prefix: Buffer | null }
  | { readonly kind: "unread" };

/** An inventoried digest the member's complete bytes must still match. */
export interface ExpectedMemberDigest {
  readonly sha256: string;
  readonly changed: string;
}

export interface MemberIoContext {
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal | undefined;
}

export interface MemberBytesTracker {
  memberBytesRead: number;
}

export const overAllowance = (bytes: Buffer): MemberRead => ({
  kind: "over_allowance",
  prefix: bytes.subarray(0, MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
});

export const fitAllowance = (bytes: Buffer, budget: number): MemberRead =>
  bytes.length <= budget ? { kind: "bytes", bytes } : overAllowance(bytes);

/**
 * A file that changed while being read is a changed release member, unless the
 * caller is reading the selected artifact itself.
 */
export const asReadFailure = (
  cause: unknown,
  integrityCheck: ArtifactIntegrityCheck = "member-identity",
): unknown =>
  cause instanceof RegularFileChangedError
    ? new ArtifactReaderFailure("integrity", cause.message, {
        cause,
        integrityCheck,
      })
    : cause;

/**
 * A read that left cleanup unfinished is never a skipped member, whatever its
 * reason: only the error tells the caller a descriptor is still retained.
 */
export const rethrowReadFailure = (
  cause: unknown,
  integrityCheck?: ArtifactIntegrityCheck,
): void => {
  const failure = asReadFailure(cause, integrityCheck);
  if (failure instanceof AnalysisError) throw failure;
  if (
    failure instanceof ArtifactReaderFailure &&
    (failure.reason === "cancelled" ||
      failure.reason === "integrity" ||
      failure.cleanup !== undefined)
  )
    throw failure;
};

/**
 * Own one member descriptor. A failed close stays retained by the resource
 * scope, and the primary failure survives it.
 */
export const withMemberDescriptor = async <T>(
  filePath: string,
  { resources, signal }: MemberIoContext,
  use: (source: StableRegularFileDescriptor) => Promise<T>,
): Promise<T> => {
  const source = await openRootArtifact(filePath, resources, signal);
  let settled: Result<T, unknown>;
  try {
    settled = ok(await use(source));
  } catch (cause) {
    settled = err(asReadFailure(cause));
  }
  await releaseRootArtifact(
    filePath,
    source.owner,
    resources,
    settled.ok
      ? { kind: "completed", digest: null }
      : { kind: "failed", cause: settled.error },
    signal,
  );
  if (!settled.ok) throw settled.error;
  return settled.value;
};

export const readStreamBounded = async (
  stream: Readable,
  budget: number,
  tracker: MemberBytesTracker,
  signal: AbortSignal | undefined,
  expected?: ExpectedMemberDigest,
): Promise<MemberRead> => {
  const chunks: Buffer[] = [];
  const hash = expected === undefined ? undefined : createHash("sha256");
  let total = 0;
  let overBudget = false;
  let failure: unknown;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw cancelledBy(OPERATION, signal);
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(piece);
      total += piece.length;
      tracker.memberBytesRead += piece.length;
      if (total > budget) {
        overBudget = true;
        break;
      }
      hash?.update(piece);
    }
    // The digest covers the whole member, so it is only checked when the
    // member ended within the allowance. A member past the allowance is never
    // read further to finish the hash: it stays over_allowance, unverified.
    if (
      !overBudget &&
      expected !== undefined &&
      hash !== undefined &&
      hash.digest("hex") !== expected.sha256
    )
      throw new ArtifactReaderFailure("integrity", expected.changed, {
        integrityCheck: "member-identity",
      });
  } catch (cause) {
    failure = cause;
  }
  let closeFailure: unknown;
  try {
    stream.destroy();
  } catch (cause) {
    closeFailure = cause;
  }
  if (failure !== undefined && closeFailure !== undefined)
    throw new AggregateError(
      [failure, closeFailure],
      "Member read and stream close both failed.",
    );
  if (closeFailure !== undefined) throw closeFailure;
  if (failure !== undefined) throw failure;
  const bytes = Buffer.concat(chunks);
  return overBudget ? overAllowance(bytes) : { kind: "bytes", bytes };
};

export const readSpan = async (
  filePath: string,
  offset: number,
  length: number,
  tracker: MemberBytesTracker,
  context: MemberIoContext,
  onLimitation: (message: string) => void,
): Promise<Buffer | null> => {
  const { signal } = context;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  )
    return null;
  try {
    return await withMemberDescriptor(
      filePath,
      context,
      async ({ handle, initial }) => {
        const observed = await handle.stat();
        if (!sameRegularFileState(initial, observed))
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact changed before read: ${filePath}`,
            { integrityCheck: "member-identity" },
          );
        if (offset + length > observed.size) return null;
        // Charge bytes as they arrive, so a read that fails after partial
        // progress still counts what it consumed against the allowance.
        let charged = 0;
        const bytes = await readFileHandleRange(
          handle,
          offset,
          length,
          (bytesRead) => {
            tracker.memberBytesRead += bytesRead - charged;
            charged = bytesRead;
            if (signal?.aborted) throw cancelledBy(OPERATION, signal);
          },
        );
        const after = await handle.stat();
        if (!sameRegularFileState(initial, after))
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact changed during read: ${filePath}`,
            { integrityCheck: "member-identity" },
          );
        tracker.memberBytesRead += bytes.length - charged;
        return bytes;
      },
    );
  } catch (cause) {
    rethrowReadFailure(cause);
    onLimitation(`Could not read ${filePath}.`);
    return null;
  }
};

export const readDiskMember = async (
  filePath: string,
  maxBytes: number,
  expectedSha256: string | undefined,
  tracker: MemberBytesTracker,
  context: MemberIoContext,
  onLimitation: (message: string) => void,
): Promise<MemberRead> => {
  try {
    const snapshot = await readStableArtifact(
      filePath,
      maxBytes,
      context.signal,
      undefined,
      context.resources,
    );
    if (expectedSha256 !== undefined && snapshot.sha256 !== expectedSha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Member changed during acquisition: ${filePath}`,
        { integrityCheck: "member-identity" },
      );
    return { kind: "bytes", bytes: snapshot.bytes };
  } catch (cause) {
    rethrowReadFailure(cause);
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return {
        kind: "over_allowance",
        prefix: await readSpan(
          filePath,
          0,
          Math.min(maxBytes, MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
          tracker,
          context,
          onLimitation,
        ),
      };
    onLimitation(`Could not read ${filePath}.`);
    return { kind: "unread" };
  }
};

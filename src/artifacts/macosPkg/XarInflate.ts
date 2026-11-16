import type { Transform } from "node:stream";
import * as zlib from "node:zlib";

import {
  MACOS_PKG_FORMAT,
  macosPkgLimitFailure,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import { malformedInput, unsupportedInput } from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  ArtifactReaderFailure,
  artifactReaderLimitFailure,
} from "../../resources/index.js";

const STORED_ENCODINGS = new Set([
  "application/octet-stream",
  "",
  "application/x-macbinary",
]);

const ZLIB_ENCODINGS = new Set([
  "application/x-gzip",
  "application/gzip",
  "application/zlib",
]);

export const isXarStoredEncoding = (encoding: string): boolean =>
  STORED_ENCODINGS.has(encoding);

export const isXarZlibEncoding = (encoding: string): boolean =>
  ZLIB_ENCODINGS.has(encoding);

/**
 * Largest archived (heap) length a member may span for a decode allowance.
 * Stored members are copied as-is; a zlib stream that decodes within the
 * allowance never needs more than zlib's compressBound of it. Unsupported
 * encodings are never read, so they have no input allowance.
 */
export const maxXarArchivedBytes = (
  encoding: string,
  maxOutputBytes: number,
): number => {
  if (isXarStoredEncoding(encoding)) return maxOutputBytes;
  if (!isXarZlibEncoding(encoding)) return 0;
  return (
    maxOutputBytes +
    Math.floor(maxOutputBytes / 4096) +
    Math.floor(maxOutputBytes / 16384) +
    Math.floor(maxOutputBytes / 33554432) +
    13
  );
};

export const extractedSizeExceedsBudget = (
  declaredSize: number,
  maxOutputBytes: number,
): boolean => declaredSize > maxOutputBytes;

export const extractedSizeLimitError = (
  path: string,
  declaredSize: number,
  maxOutputBytes: number,
): MacosPkgParseError =>
  macosPkgLimitFailure(
    `${path} extracted size ${String(declaredSize)} exceeds the ${String(maxOutputBytes)}-byte decode allowance`,
    {
      name: "macos_pkg_extracted_size",
      maximum: maxOutputBytes,
      required: declaredSize,
    },
    "size",
  );

export const extractedSizeMismatchError = (
  path: string,
  declaredSize: number,
  actualLength: number,
): MacosPkgParseError =>
  malformedInput(
    MACOS_PKG_FORMAT,
    `${path} extracted size ${String(declaredSize)} does not match the ${String(actualLength)}-byte decoded member`,
    { field: "extracted-size" },
  );

export const isZlibOutputLimitError = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    /exceeding/iu.test(message) ||
    /maxOutputLength/u.test(message) ||
    /too small/iu.test(message)
  );
};

const inflateLimitError = (
  path: string,
  maxOutputBytes: number,
): MacosPkgParseError =>
  macosPkgLimitFailure(
    `${path} zlib payload exceeds the ${String(maxOutputBytes)}-byte decode allowance`,
    {
      name: "macos_pkg_extracted_size",
      maximum: maxOutputBytes,
    },
    "gzip",
  );

/** Inflate a zlib/gzip-encoded XAR heap member, capped at the named allowance. */
export const inflateXarMemberBytes = (
  archived: Buffer,
  encoding: string,
  maxOutputBytes: number,
  path: string,
): Result<Buffer, MacosPkgParseError> => {
  if (isXarStoredEncoding(encoding)) return ok(archived);
  if (!isXarZlibEncoding(encoding))
    return err(
      unsupportedInput(
        MACOS_PKG_FORMAT,
        `XAR member encoding ${encoding} is unsupported`,
        { field: "encoding", undecodedContent: true },
      ),
    );
  try {
    return ok(zlib.inflateSync(archived, { maxOutputLength: maxOutputBytes }));
  } catch (cause: unknown) {
    if (isZlibOutputLimitError(cause))
      return err(inflateLimitError(path, maxOutputBytes));
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `${path} zlib payload is not valid zlib data`,
        { field: "gzip", cause },
      ),
    );
  }
};

export const mapXarInflateStreamError = (
  cause: unknown,
  maxOutputBytes: number,
  path: string,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (isZlibOutputLimitError(cause))
    return artifactReaderLimitFailure(
      "artifact_limits.expanded_bytes",
      maxOutputBytes,
      "bytes",
      undefined,
      "memory",
    );
  const detail =
    cause instanceof Error
      ? `XAR member zlib inflate failed: ${path}: ${cause.message}`
      : `XAR member zlib inflate failed: ${path}`;
  return new ArtifactReaderFailure("format", detail, { cause });
};

/**
 * Stream-decode a zlib-encoded XAR member, capped at the resource policy
 * allowance rather than the attacker-controlled TOC extracted size.
 * `maxOutputLength` does not bound a streaming inflater, so emitted bytes are
 * counted here and the stream fails before any excess chunk is forwarded.
 */
export const createBoundedXarInflate = (
  maxOutputBytes: number,
  path: string,
): Transform => {
  const inflate = zlib.createInflate();
  let emitted = 0;
  const push = inflate.push.bind(inflate);
  inflate.push = ((chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk !== null && chunk !== undefined) {
      emitted += (chunk as Buffer).length;
      if (emitted > maxOutputBytes) {
        inflate.destroy(
          artifactReaderLimitFailure(
            "artifact_limits.expanded_bytes",
            maxOutputBytes,
            "bytes",
            emitted,
            "memory",
          ),
        );
        return false;
      }
    }
    return push(chunk, encoding);
  }) as typeof inflate.push;
  const emit = inflate.emit.bind(inflate);
  inflate.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "error") {
      const mapped = mapXarInflateStreamError(args[0], maxOutputBytes, path);
      return emit(event, mapped);
    }
    return emit(event, ...args);
  }) as typeof inflate.emit;
  return inflate;
};

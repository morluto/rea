import type { Transform } from "node:stream";
import * as zlib from "node:zlib";

import {
  MACOS_PKG_FORMAT,
  macosPkgLimitFailure,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import { malformedInput, unsupportedInput } from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { artifactReaderLimitFailure } from "../ArtifactReaderLimits.js";

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
 * Stream-decode a zlib-encoded XAR member. `maxOutputLength` is the resource
 * policy, not the attacker-controlled TOC extracted size.
 */
export const createBoundedXarInflate = (
  maxOutputBytes: number,
  path: string,
): Transform => {
  const inflate = zlib.createInflate({ maxOutputLength: maxOutputBytes });
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

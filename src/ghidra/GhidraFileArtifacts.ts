import { systemCodeFromError } from "../kernel/reportedSystemCode.js";
import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import type { Hash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  type ArtifactResourceScope,
  ArtifactReaderFailure,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
  mapArtifactFileFailure,
  bindArtifactFileCleanup,
  withArtifactFileHandle,
  withArtifactRegularFile,
} from "../resources/index.js";
import {
  readStableFileBytes,
  RegularFileCapacityError,
} from "../filesystem/readStableFileBytes.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Bounded serial read; the caller owns admission and final descriptor cleanup. */
export const readGhidraProfileArtifact = <Value>(
  path: string,
  maximumBytes: number,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
  interpret: (bytes: Buffer) => Value,
): Promise<Value> =>
  withArtifactRegularFile(path, resources, signal, async ({ handle: file }) => {
    const bytes = await readStableFileBytes(file, path, maximumBytes, {
      symlinks: "reject",
      ...(signal === undefined ? {} : { signal }),
    });
    return interpret(bytes);
  });

/** Own the new private snapshot descriptor through write and final close. */
export const writeGhidraProfileArtifact = async (
  path: string,
  bytes: Buffer | string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<void> => {
  assertArtifactReadActive(signal);
  const file = await open(path, "wx", 0o600);
  await withArtifactFileHandle(path, file, resources, signal, (handle) =>
    handle.writeFile(bytes),
  );
};

const STREAM_COPY_BUFFER_BYTES = 256 * 1024;

/** Single-pass regular-file copy with optional SHA-256 streaming and descriptor ownership. */
export const copyGhidraRegularFile = async (
  sourcePath: string,
  destinationPath: string,
  resources: ArtifactResourceScope,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly buffer?: Buffer | undefined;
    readonly hash?: Hash | undefined;
    readonly sync?: boolean | undefined;
    readonly onOpenedSource?: ((initialSize: number) => void) | undefined;
  } = {},
): Promise<void> => {
  const { signal, hash, sync, onOpenedSource } = options;
  const scratch =
    options.buffer ?? Buffer.allocUnsafe(STREAM_COPY_BUFFER_BYTES);
  await withArtifactRegularFile(
    sourcePath,
    resources,
    signal,
    async ({ handle: srcHandle, initial }) => {
      onOpenedSource?.(initial.size);
      assertArtifactReadActive(signal);
      const destHandle = await open(
        destinationPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await withArtifactFileHandle(
        destinationPath,
        destHandle,
        resources,
        signal,
        async (dest) => {
          for (let offset = 0; offset < initial.size;) {
            assertArtifactReadActive(signal);
            const { bytesRead } = await srcHandle.read(
              scratch,
              0,
              Math.min(scratch.length, initial.size - offset),
              offset,
            );
            if (bytesRead === 0) throw new RegularFileChangedError(sourcePath);
            hash?.update(scratch.subarray(0, bytesRead));
            for (let written = 0; written < bytesRead;) {
              assertArtifactReadActive(signal);
              const { bytesWritten } = await dest.write(
                scratch,
                written,
                bytesRead - written,
                offset + written,
              );
              if (bytesWritten === 0)
                throw new Error(
                  `Short write copying artifact to ${destinationPath}`,
                );
              written += bytesWritten;
            }
            offset += bytesRead;
          }
          assertArtifactReadActive(signal);
          if (!sameRegularFileState(initial, await srcHandle.stat()))
            throw new RegularFileChangedError(sourcePath);
          if (sync) {
            assertArtifactReadActive(signal);
            await dest.sync();
          }
        },
      );
    },
    "reject",
  );
};

/** Ghidra's typed meaning for one physical file failure, else the failure. */
const ghidraPhysicalFailure = (
  primary: unknown,
  operation: string,
  diagnostics: Readonly<Record<string, JsonValue>>,
): unknown => {
  if (primary instanceof RegularFileCapacityError)
    return new AnalysisResourceConstraintError(
      operation,
      "file-size",
      primary.message,
      {
        maximum_bytes: primary.maximumBytes,
        observed_bytes: primary.observedBytes.toString(),
      },
      { cause: primary, diagnostics, retryable: false },
    );
  if (primary instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(
      operation,
      primary.path,
      primary.message,
      { cause: primary, diagnostics },
    );
  if (
    primary instanceof Error &&
    "code" in primary &&
    (primary.code === "EACCES" || primary.code === "EPERM")
  ) {
    const path =
      "path" in primary && typeof primary.path === "string"
        ? primary.path
        : diagnostics.path;
    if (typeof path === "string")
      return new AnalysisAccessDeniedError(operation, path, primary.code, {
        cause: primary,
        diagnostics,
      });
  }
  return primary;
};

/**
 * Ghidra's dialect for a file it reads or writes: its typed physical
 * failures, composed with the file's unresolved cleanup, and an adapter
 * report that keeps that cleanup for anything else. The shared owner reports
 * the read's cancellation with these diagnostics.
 */
export const ghidraFileDialect = (
  operation: string,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): ProviderFailureDialect => ({
  providerId: "ghidra",
  operation,
  diagnostics,
  recognise: (cause) => {
    const mapped = mapArtifactFileFailure(cause, (primary) =>
      ghidraPhysicalFailure(primary, operation, diagnostics),
    );
    const { cause: primary, origin } = artifactFilePrimaryFacts(mapped);
    if (origin !== "owned-or-classified" || !(primary instanceof AnalysisError))
      return undefined;
    const cleanup =
      mapped instanceof ArtifactReaderFailure ? mapped.cleanup : undefined;
    if (cleanup === undefined) return primary;
    const failure = new ProviderCleanupError(
      "ghidra",
      cleanup.resources,
      { reason: cleanup.reason },
      { cause: mapped },
    );
    bindArtifactFileCleanup(mapped, failure);
    return analysisErrorWithCleanupDependencies(primary, failure, operation);
  },
  unclassified: (cause, details) => {
    const { cause: primary } = artifactFilePrimaryFacts(cause);
    const admission =
      primary instanceof GhidraAdmissionError ? primary : undefined;
    const reason = admission?.code ?? errorMessage(primary);
    const systemCode =
      admission === undefined ? systemCodeFromError(primary) : undefined;
    return new ProviderAdapterError("ghidra", operation, {
      ...details,
      cause,
      diagnostics: {
        ...admission?.detail,
        ...diagnostics,
        ...(admission === undefined ? {} : { code: admission.code }),
        ...(systemCode === undefined ? {} : { system_code: systemCode }),
        ...(primary instanceof Error &&
        "syscall" in primary &&
        typeof primary.syscall === "string"
          ? { syscall: primary.syscall }
          : {}),
        reason,
      },
      userMessage: reason,
    });
  },
});

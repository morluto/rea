import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";

/** Fingerprint exact selected or derived bytes. */
export const recoveryDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Read a stable regular file without retaining bytes during engine fingerprinting. */
const scanRecoveryFile = async (
  path: string,
  maximum: number,
  consume: (chunk: Buffer) => void,
  signal?: AbortSignal,
) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum)
      throw new AnalysisOutputError(
        OPERATION,
        `Expected a regular file no larger than ${String(maximum)} bytes: ${path}`,
      );
    let bytes = 0;
    for await (const raw of handle.createReadStream({ autoClose: false })) {
      checkRecoveryCancellation(signal);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maximum)
        throw new AnalysisOutputError(
          OPERATION,
          `File exceeds ${String(maximum)} bytes: ${path}`,
        );
      hash.update(chunk);
      consume(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== bytes ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      throw new AnalysisOutputError(
        OPERATION,
        `File identity changed while reading: ${path}`,
      );
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
};

/** Fingerprint a regular file incrementally with bounded memory. */
export const fingerprintRecoveryFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
) => scanRecoveryFile(path, maximum, () => {}, signal);

/** Read only a regular file through one handle with a bounded, stable identity. */
export const readRecoveryFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const result = await scanRecoveryFile(
    path,
    maximum,
    (chunk) => chunks.push(chunk),
    signal,
  );
  return Buffer.concat(chunks, result.bytes);
};

/** Snapshot one caller-selected UTF-8 script before invoking the engine. */
export const snapshotRecoveryInput = async (
  path: string,
  snapshotPath: string,
  signal?: AbortSignal,
) => {
  if (!isAbsolute(path))
    throw recoveryInputFailure(
      "path",
      "Select an absolute JavaScript file path",
    );
  let bytes: Buffer;
  try {
    bytes = await readRecoveryFile(path, RECOVERY_LIMITS.inputBytes, signal);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) throw cause;
    throw recoveryInputFailure(
      "path",
      `Cannot snapshot UTF-8 JavaScript input ${path}: ${recoveryFailureMessage(cause)}`,
      cause,
    );
  }
  await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    path,
    snapshot_path: snapshotPath,
    sha256: recoveryDigest(bytes),
    bytes: bytes.length,
  };
};

/** Inventory staging without following symlinks or publishing special files. */
export const inventoryRecoveryFiles = async (
  root: string,
  signal?: AbortSignal,
): Promise<
  readonly { relativePath: string; path: string; bytes: number }[]
> => {
  const files: { relativePath: string; path: string; bytes: number }[] = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new AnalysisOutputError(
        OPERATION,
        `Unsafe staging directory: ${directory}`,
      );
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      checkRecoveryCancellation(signal);
      entries++;
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (entries > RECOVERY_LIMITS.outputEntries)
        throw new AnalysisOutputError(
          OPERATION,
          "Recovery staging exceeds the 10000-entry resource limit",
        );
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new AnalysisOutputError(
          OPERATION,
          `Recovery produced a symlink or special file: ${relativePath}`,
        );
      if (info.isDirectory()) await visit(path, relativePath);
      else {
        bytes += info.size;
        if (bytes > RECOVERY_LIMITS.outputBytes)
          throw new AnalysisOutputError(
            OPERATION,
            "Recovery staging exceeds the 128 MiB resource limit",
          );
        files.push({ relativePath, path, bytes: info.size });
      }
    }
  };
  await visit(root, "");
  return files;
};

/** Preserve actionable caller constraints in the ordinary error algebra. */
export const recoveryInputFailure = (
  field: string,
  message: string,
  cause?: unknown,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, { cause }, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** Convert one caught boundary cause into diagnostic text without masking its type. */
export const recoveryFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Cancellation remains distinct from malformed source or provider output. */
export const checkRecoveryCancellation = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
};

/** Keep both tool invocations within one operation's execution budget. */
export const checkRecoveryDeadline = (
  deadline: number,
  signal?: AbortSignal,
): void => {
  checkRecoveryCancellation(signal);
  if (Date.now() >= deadline)
    throw new AnalysisTimeoutError(OPERATION, RECOVERY_LIMITS.timeoutMs);
};

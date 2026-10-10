import { createHash } from "node:crypto";
import type { ReadStream, Stats, WriteStream } from "node:fs";
import { chmod, open, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import {
  openRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";

/** Bind decompiler input to the admitted artifact, even if the original changes. */
export const snapshotAndroidTarget = async (
  path: string,
  sha256: string,
  root: string,
  operation: AndroidOperation,
): Promise<string> => {
  const snapshot = join(root, "target.apk");
  try {
    await copyAndroidSnapshot(path, snapshot, sha256);
    await chmod(snapshot, 0o400);
    return snapshot;
  } catch (cause: unknown) {
    if (!(cause instanceof AndroidSnapshotChangedError)) throw cause;
    throw new AnalysisInputError(operation, { cause }, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: `APK bytes changed after admission at ${path}; retry against a stable file.`,
      },
    ]);
  }
};

/** Fingerprint the actual immutable engine bytes executed for this observation. */
export const snapshotAndroidEngine = async (
  source: string,
  sha256: string,
  root: string,
  operation: AndroidOperation,
): Promise<{ path: string; sha256: string }> => {
  const path = join(root, "engine.jar");
  try {
    const observed = await copyAndroidSnapshot(source, path, sha256);
    await chmod(path, 0o400);
    return { path, sha256: observed };
  } catch (cause: unknown) {
    if (!(cause instanceof AndroidSnapshotChangedError)) throw cause;
    throw new AnalysisCapabilityUnavailableError(
      "jadx",
      operation,
      `REA_JADX_MCP_JAR bytes changed during admission at ${source}; retry with a stable engine file.`,
      { cause },
    );
  }
};

const copyAndroidSnapshot = async (
  sourcePath: string,
  snapshotPath: string,
  expectedSha256: string,
): Promise<string> => {
  const source = await openRegularFile(sourcePath, { symlinks: "follow" });
  let destination: FileHandle | undefined;
  let inputStream: ReadStream | undefined;
  let outputStream: WriteStream | undefined;
  let copiedBytes = 0;
  const hash = createHash("sha256");
  try {
    const initial = await source.stat();
    const digest = new Transform({
      transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
      ) {
        copiedBytes += chunk.length;
        if (copiedBytes > initial.size) {
          callback(
            new AndroidSnapshotChangedError(
              `Android input grew while being copied: ${sourcePath}`,
            ),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      destination = await open(snapshotPath, "wx", 0o600);
      inputStream = source.createReadStream({
        start: 0,
        end: initial.size,
        autoClose: false,
      });
      outputStream = destination.createWriteStream({ autoClose: false });
      await pipeline(inputStream, digest, outputStream);
      await verifySourceState(source, sourcePath, initial, copiedBytes);
      const observedSha256 = hash.digest("hex");
      if (observedSha256 !== expectedSha256)
        throw new AndroidSnapshotChangedError(
          `Android snapshot digest mismatch for ${sourcePath}`,
        );
      return observedSha256;
    } catch (cause: unknown) {
      if (destination !== undefined)
        await rm(snapshotPath, { force: true }).catch(() => undefined);
      throw cause;
    }
  } finally {
    // Non-auto-closing streams retain a reference to their FileHandle even
    // after pipeline completion. Release those references before awaiting
    // descriptor closure, after the admitted source state has been verified.
    inputStream?.destroy();
    outputStream?.destroy();
    await Promise.all([source.close(), destination?.close()]);
  }
};

const verifySourceState = async (
  handle: Awaited<ReturnType<typeof openRegularFile>>,
  path: string,
  initial: Stats,
  observedBytes: number,
): Promise<void> => {
  const [opened, currentPath] = await Promise.all([handle.stat(), stat(path)]);
  if (
    observedBytes !== initial.size ||
    !sameRegularFileState(initial, opened) ||
    !sameRegularFileState(initial, currentPath)
  )
    throw new AndroidSnapshotChangedError(
      `Android input changed while being read: ${path}`,
    );
};

class AndroidSnapshotChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

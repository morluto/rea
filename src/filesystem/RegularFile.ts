import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { OwnedFileHandle } from "./OwnedFileHandle.js";

/** Identifies a selected path that cannot be read as one regular file. */
export class NonRegularFileReadError extends Error {
  readonly code: "EISDIR" | "ENOTFILE";

  constructor(
    readonly path: string,
    directory: boolean,
  ) {
    super(`Selected input must be a regular file: ${path}`);
    this.name = "NonRegularFileReadError";
    this.code = directory ? "EISDIR" : "ENOTFILE";
  }
}

/** Admission failed and the opened descriptor could not be confirmed closed. */
export class RegularFileAdmissionFailure extends Error {
  override readonly cause: unknown;

  constructor(
    readonly path: string,
    admissionCause: unknown,
    readonly cleanupCause: unknown,
    readonly owner: OwnedFileHandle,
  ) {
    super(
      `Selected input failed admission and its descriptor close failed: ${path}`,
    );
    this.name = "RegularFileAdmissionFailure";
    this.cause = admissionCause;
  }
}

/** A regular input no longer matches the extent or identity admitted for reading. */
export class RegularFileChangedError extends Error {
  readonly code = "ESTALE";
  constructor(readonly path: string) {
    super(`Selected input changed while being read: ${path}`);
    this.name = "RegularFileChangedError";
  }
}

/** One admitted file descriptor and the metadata that identified its contents. */
export interface StableRegularFileDescriptor {
  readonly handle: FileHandle;
  readonly initial: Stats;
}

/** Open and verify the selected file descriptor without blocking on pipes. */
export const openRegularFile = async (
  path: string,
  options: {
    readonly symlinks: "follow" | "reject";
    readonly signal?: AbortSignal | undefined;
  },
): Promise<FileHandle> => {
  options.signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOCTTY ?? 0) |
      (options.symlinks === "reject" ? (constants.O_NOFOLLOW ?? 0) : 0),
  );
  const owner = new OwnedFileHandle(handle);
  try {
    options.signal?.throwIfAborted();
    const metadata = await handle.stat();
    options.signal?.throwIfAborted();
    if (!metadata.isFile())
      throw new NonRegularFileReadError(path, metadata.isDirectory());
    return handle;
  } catch (cause: unknown) {
    try {
      await owner.close();
    } catch (cleanupCause: unknown) {
      throw new RegularFileAdmissionFailure(path, cause, cleanupCause, owner);
    }
    throw cause;
  }
};

const deviceIdentity = (value: number | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value);

const windowsDeviceUnreported = (value: bigint): boolean =>
  process.platform === "win32" && value === 0n;

/**
 * Volume identity. Windows path stat uses 0 when it did not report a volume.
 * An unreported device matches nothing, including another unreported device.
 */
export const sameDeviceIdentity = (
  expected: number | bigint,
  observed: number | bigint,
): boolean => {
  const expectedDevice = deviceIdentity(expected);
  const observedDevice = deviceIdentity(observed);
  if (
    windowsDeviceUnreported(expectedDevice) ||
    windowsDeviceUnreported(observedDevice)
  )
    return false;
  return expectedDevice === observedDevice;
};

/**
 * Compare one regular file's metadata across a read. A Windows path stat that
 * omits the volume does not by itself show that the file was replaced. Ownership
 * checks use sameDeviceIdentity and an open handle instead.
 */
export const sameRegularFileState = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
): boolean => {
  const expectedDevice = deviceIdentity(expected.dev);
  const observedDevice = deviceIdentity(observed.dev);
  const deviceAgrees =
    windowsDeviceUnreported(expectedDevice) ||
    windowsDeviceUnreported(observedDevice) ||
    expectedDevice === observedDevice;
  return (
    observed.isFile() &&
    deviceAgrees &&
    expected.ino === observed.ino &&
    expected.size === observed.size &&
    expected.mode === observed.mode &&
    expected.mtimeMs === observed.mtimeMs &&
    expected.ctimeMs === observed.ctimeMs
  );
};

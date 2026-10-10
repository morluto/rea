import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import {
  abortIfNeeded,
  hashReadable,
  type HashResult,
} from "../ArtifactHash.js";

/** Hash one stable regular root file from the same descriptor that was checked. */
export const hashStableRootArtifact = async (
  path: string,
  signal?: AbortSignal,
): Promise<HashResult> => {
  let handle: FileHandle;
  try {
    handle = await openRegularFile(path, {
      symlinks: "reject",
      signal,
    });
  } catch (cause: unknown) {
    if (cause instanceof NonRegularFileReadError)
      throw new ArtifactReaderFailure(
        "format",
        `Artifact root is not a regular file: ${path}`,
        { cause },
      );
    throw cause;
  }
  try {
    const initial = await handle.stat();
    return await hashStableRootArtifactHandle(path, handle, initial, signal);
  } finally {
    await handle.close();
  }
};

/** Hash and revalidate the same open descriptor used for root classification. */
export const hashStableRootArtifactHandle = async (
  path: string,
  handle: FileHandle,
  initial: Stats,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const digest = await hashReadable(
    // Read at most the admitted extent plus one byte to detect growth without
    // following an actively appended file indefinitely.
    handle.createReadStream({ autoClose: false, start: 0, end: initial.size }),
    signal,
  );
  abortIfNeeded(signal);
  const [opened, currentPath] = await Promise.all([handle.stat(), lstat(path)]);
  if (
    !sameRegularFileState(initial, opened) ||
    !sameRegularFileState(initial, currentPath) ||
    digest.bytes !== initial.size
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Root artifact changed during inventory: ${path}`,
    );
  return digest;
};

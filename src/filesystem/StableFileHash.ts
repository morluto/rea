import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  openRegularFile,
  RegularFileChangedError,
  sameRegularFileState,
} from "./RegularFile.js";

/** Hash one regular file from its admitted descriptor and verify its path state. */
export const hashStableFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const handle = await openRegularFile(path, {
    symlinks: "follow",
    signal,
  });
  try {
    const initial = await handle.stat();
    if (!Number.isSafeInteger(initial.size) || initial.size < 0)
      throw new RangeError(
        `Regular file size cannot be represented safely: ${path}`,
      );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= initial.size) {
      signal?.throwIfAborted();
      const length = Math.min(chunk.length, initial.size - position + 1);
      if (length <= 0) break;
      const read = await handle.read(chunk, 0, length, position);
      signal?.throwIfAborted();
      if (read.bytesRead === 0) break;
      hash.update(chunk.subarray(0, read.bytesRead));
      position += read.bytesRead;
      if (position > initial.size) throw new RegularFileChangedError(path);
    }
    signal?.throwIfAborted();
    const [opened, currentPath] = await Promise.all([
      handle.stat(),
      stat(path),
    ]);
    signal?.throwIfAborted();
    if (
      position !== initial.size ||
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, currentPath)
    )
      throw new RegularFileChangedError(path);
    return { sha256: hash.digest("hex"), bytes: position };
  } finally {
    await handle.close();
  }
};

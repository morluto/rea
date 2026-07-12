import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { entryFailure, safeSize } from "./ReferenceSourceReaderErrors.js";
import {
  isAborted,
  sameFile,
  validateDirectory,
} from "./ReferenceSourceReaderValidate.js";
import {
  type BigStats,
  type ReferenceSourceEntry,
  type StableFileRequest,
} from "./ReferenceSourceReaderTypes.js";

const READ_CHUNK_BYTES = 64 * 1024;

type PreparedFileRead =
  | {
      readonly status: "ready";
      readonly handle: FileHandle;
      readonly before: BigStats;
      readonly parentBefore: { readonly ok: true; readonly stats: BigStats };
    }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FileContentsRead =
  | { readonly status: "ok"; readonly chunks: Buffer[]; readonly total: number }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FinalizeFileReadRequest = {
  readonly root: string;
  readonly rootIdentity: BigStats;
  readonly absolute: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly before: BigStats;
  readonly parentBefore: { readonly ok: true; readonly stats: BigStats };
  readonly chunks: Buffer[];
  readonly total: number;
};

const prepareFileRead = async (
  request: StableFileRequest,
): Promise<PreparedFileRead> => {
  const { root, rootIdentity, absolute, path, expected, signal } = request;
  const parentBefore = await validateDirectory(
    root,
    rootIdentity,
    dirname(absolute),
  );
  if (!parentBefore.ok)
    return {
      status: "failed",
      entry: entryFailure(
        path,
        "file",
        parentBefore.code,
        parentBefore.message,
        safeSize(expected.size),
      ),
    };
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  if (isAborted(signal)) {
    await handle.close().catch(() => undefined);
    return {
      status: "failed",
      entry: entryFailure(
        path,
        "file",
        "cancelled",
        "File read cancelled",
        safeSize(expected.size),
      ),
    };
  }
  const before = await handle.stat({ bigint: true });
  if (!sameFile(expected, before)) {
    await handle.close().catch(() => undefined);
    return {
      status: "failed",
      entry: entryFailure(
        path,
        "file",
        "changed",
        "File changed before it was read",
        safeSize(before.size),
      ),
    };
  }
  return { status: "ready", handle, before, parentBefore };
};

const readFileContents = async (request: {
  readonly handle: FileHandle;
  readonly path: string;
  readonly remaining: number;
  readonly signal?: AbortSignal;
}): Promise<FileContentsRead> => {
  const { handle, path, remaining, signal } = request;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (isAborted(signal))
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "cancelled",
          "File read cancelled",
          total,
        ),
      };
    const capacity = Math.min(READ_CHUNK_BYTES, remaining + 1 - total);
    if (capacity <= 0)
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "limit",
          "File exceeds remaining maxBytes",
          total,
        ),
      };
    const chunk = Buffer.allocUnsafe(capacity);
    const read = await handle.read(chunk, 0, capacity, null);
    if (isAborted(signal))
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "cancelled",
          "File read cancelled",
          total,
        ),
      };
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
    if (total > remaining)
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "limit",
          "File exceeds remaining maxBytes",
          total,
        ),
      };
    chunks.push(chunk.subarray(0, read.bytesRead));
  }
  return { status: "ok", chunks, total };
};

const finalizeFileRead = async (
  request: FinalizeFileReadRequest,
): Promise<ReferenceSourceEntry> => {
  const {
    root,
    rootIdentity,
    absolute,
    path,
    handle,
    before,
    parentBefore,
    chunks,
    total,
  } = request;
  const after = await handle.stat({ bigint: true });
  const parentAfter = await validateDirectory(
    root,
    rootIdentity,
    dirname(absolute),
  );
  if (!parentAfter.ok || !sameFile(parentBefore.stats, parentAfter.stats))
    return entryFailure(
      path,
      "file",
      "changed",
      "Parent directory changed while file was read",
      total,
    );
  if (!sameFile(before, after) || BigInt(total) !== after.size)
    return entryFailure(
      path,
      "file",
      "changed",
      "File changed while it was read",
      total,
    );
  return {
    status: "read",
    kind: "file",
    path,
    bytes: Buffer.concat(chunks, total),
    size: total,
  };
};

export const readStableFile = async (
  request: StableFileRequest,
): Promise<ReferenceSourceEntry> => {
  const { root, rootIdentity, absolute, path, expected, remaining, signal } =
    request;
  let handle: FileHandle | undefined;
  try {
    const prepared = await prepareFileRead(request);
    if (prepared.status === "failed") return prepared.entry;
    handle = prepared.handle;
    const contents = await readFileContents({
      handle,
      path,
      remaining,
      ...(signal === undefined ? {} : { signal }),
    });
    if (contents.status === "failed") return contents.entry;
    return await finalizeFileRead({
      root,
      rootIdentity,
      absolute,
      path,
      handle,
      before: prepared.before,
      parentBefore: prepared.parentBefore,
      chunks: contents.chunks,
      total: contents.total,
    });
  } catch {
    return entryFailure(
      path,
      "file",
      isAborted(signal) ? "cancelled" : "io",
      "File could not be read safely",
      safeSize(expected.size),
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

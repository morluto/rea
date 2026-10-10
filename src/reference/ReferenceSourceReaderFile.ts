import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  entryFailure,
  filesystemFailureDetail,
  safeSize,
} from "./ReferenceSourceReaderErrors.js";
import {
  isAborted,
  sameFile,
  validateDirectory,
} from "./ReferenceSourceReaderValidate.js";
import {
  type ReferenceSourceEntry,
  type StableFileRequest,
} from "./ReferenceSourceReaderTypes.js";

const READ_CHUNK_BYTES = 64 * 1024;

type PreparedFileRead =
  | {
      readonly status: "ready";
      readonly before: BigIntStats;
    }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FileContentsRead =
  | { readonly status: "ok"; readonly chunks: Buffer[]; readonly total: number }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FinalizeFileReadRequest = {
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly absolute: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly before: BigIntStats;
  readonly parentBefore: { readonly ok: true; readonly stats: BigIntStats };
  readonly chunks: Buffer[];
  readonly total: number;
  readonly signal?: AbortSignal;
};

const prepareFileRead = async (
  request: StableFileRequest,
  handle: FileHandle,
): Promise<PreparedFileRead> => {
  const { path, expected, signal } = request;
  if (isAborted(signal)) {
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
  return { status: "ready", before };
};

const readFileContents = async (request: {
  readonly handle: FileHandle;
  readonly path: string;
  readonly signal?: AbortSignal;
}): Promise<FileContentsRead> => {
  const { handle, path, signal } = request;
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
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const read = await handle.read(chunk, 0, chunk.byteLength, null);
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
    request.signal,
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
  const { root, rootIdentity, absolute, path, expected, signal } = request;
  let handle: FileHandle | undefined;
  try {
    const parentBefore = await validateDirectory(
      root,
      rootIdentity,
      dirname(absolute),
      signal,
    );
    if (!parentBefore.ok)
      return entryFailure(
        path,
        "file",
        parentBefore.code,
        parentBefore.message,
        safeSize(expected.size),
      );
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const prepared = await prepareFileRead(request, handle);
    if (prepared.status === "failed") return prepared.entry;
    const contents = await readFileContents({
      handle,
      path,
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
      parentBefore,
      chunks: contents.chunks,
      total: contents.total,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    if (isAborted(signal))
      return entryFailure(
        path,
        "file",
        "cancelled",
        "File read cancelled",
        safeSize(expected.size),
      );
    const message = filesystemFailureDetail(
      cause,
      "File could not be read safely",
    );
    if (message === undefined) throw cause;
    return entryFailure(path, "file", "io", message, safeSize(expected.size));
  } finally {
    // best-effort cleanup: file-handle close must not mask the read result.
    await handle?.close().catch(() => undefined);
  }
};

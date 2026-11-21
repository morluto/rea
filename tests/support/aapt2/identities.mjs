import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hashStableFile } from "../../../dist/filesystem/StableFileHash.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../../../dist/filesystem/OwnedRegularFile.js";

/** Publish each completed physical hash before awaiting another operation or cleanup. */
export function createIdentityRecorder(
  scope,
  signal,
  { hash = hashStableFile, directory = readdir } = {},
) {
  const identity = async (path, publish = () => {}) => {
    try {
      const value = await scope.run(() =>
        hash(path, {
          signal,
          retainFailedClose: (handle) =>
            scope.retain({ kind: "file-handle", resource: path, handle }),
        }),
      );
      publish({ sha256: value.sha256, bytes: value.bytes });
      return value;
    } catch (cause) {
      if (
        (cause instanceof RegularFileCancelled ||
          cause instanceof RegularFileCleanupFailure) &&
        cause.outcome.kind === "completed"
      ) {
        const value = cause.outcome.value;
        publish({ sha256: value.sha256, bytes: value.bytes });
      }
      throw cause;
    }
  };
  const tree = async (path, entries, prefix = "") => {
    const children = await directory(path, { withFileTypes: true });
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory())
        await tree(join(path, entry.name), entries, prefix + entry.name + "/");
      else {
        assert(entry.isFile());
        await identity(join(path, entry.name), (value) =>
          entries.push({ path: prefix + entry.name, ...value }),
        );
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  };
  return { identity, tree };
}

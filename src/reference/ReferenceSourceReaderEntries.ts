import { readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { entryFailure, safeSize } from "./ReferenceSourceReaderErrors.js";
import {
  compareNames,
  pathFromRoot,
  withinRoot,
} from "./ReferenceSourceReaderPaths.js";
import { readStableFile } from "./ReferenceSourceReaderFile.js";
import {
  isAborted,
  sameFile,
  validateDirectory,
  bigLstat,
} from "./ReferenceSourceReaderValidate.js";
import {
  type BigStats,
  type PendingDirectory,
  type ReferenceSourceEntry,
  type ReferenceSourceResult,
  type TraversalState,
} from "./ReferenceSourceReaderTypes.js";

export const traverseDirectory = async (
  state: TraversalState,
  current: PendingDirectory,
): Promise<ReferenceSourceResult<undefined>> => {
  const before = await validateDirectory(
    state.root,
    state.rootIdentity,
    current.path,
  );
  if (!before.ok) {
    state.entries.push(
      entryFailure(
        pathFromRoot(state.root, current.path),
        "directory",
        before.code,
        before.message,
      ),
    );
    return { ok: true, value: undefined };
  }
  const names = await readDirectoryNames(current.path);
  if (!names.ok) {
    state.entries.push(
      entryFailure(
        pathFromRoot(state.root, current.path),
        "directory",
        "io",
        names.message,
      ),
    );
    return { ok: true, value: undefined };
  }
  if (isAborted(state.signal))
    return {
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      },
    };
  const after = await validateDirectory(
    state.root,
    state.rootIdentity,
    current.path,
  );
  if (!after.ok || !sameFile(before.stats, after.stats)) {
    state.entries.push(
      entryFailure(
        pathFromRoot(state.root, current.path),
        "directory",
        "changed",
        "Directory changed while it was read",
      ),
    );
    return { ok: true, value: undefined };
  }
  const directories: PendingDirectory[] = [];
  for (const name of names.value) {
    const result = await processEntry(state, current, name, directories);
    if (!result.ok) return result;
    if (state.stopped) break;
  }
  directories.reverse();
  state.pending.push(...directories);
  return { ok: true, value: undefined };
};

const readDirectoryNames = async (
  path: string,
): Promise<
  | { readonly ok: true; readonly value: string[] }
  | { readonly ok: false; readonly message: string }
> => {
  try {
    return { ok: true, value: (await readdir(path)).sort(compareNames) };
  } catch {
    return { ok: false, message: "Directory could not be read" };
  }
};

const readMetadata = async (
  path: string,
): Promise<
  | { readonly ok: true; readonly value: BigStats }
  | { readonly ok: false; readonly message: string }
> => {
  try {
    return { ok: true, value: await bigLstat(path) };
  } catch {
    return { ok: false, message: "Entry metadata could not be read" };
  }
};

const processEntry = async (
  state: TraversalState,
  current: PendingDirectory,
  name: string,
  directories: PendingDirectory[],
): Promise<ReferenceSourceResult<undefined>> => {
  if (isAborted(state.signal))
    return {
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      },
    };
  const absolute = join(current.path, name);
  const path = pathFromRoot(state.root, absolute);
  const excluded = applyExclusion(state.shouldExclude, path);
  if (!excluded.ok)
    return {
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "io",
        message: "Reference source exclusion check failed",
      },
    };
  if (excluded.value) return { ok: true, value: undefined };
  if (!reserveEntry(state)) return { ok: true, value: undefined };
  if (Buffer.byteLength(path) > state.limits.maxPathBytes) {
    state.entries.push(
      entryFailure(path, "unknown", "limit", "Path exceeds maxPathBytes"),
    );
    state.truncated = true;
    return { ok: true, value: undefined };
  }
  const metadata = await readMetadata(absolute);
  if (!metadata.ok) {
    state.entries.push(entryFailure(path, "unknown", "io", metadata.message));
    return { ok: true, value: undefined };
  }
  if (isAborted(state.signal))
    return {
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      },
    };
  if (metadata.value.isSymbolicLink())
    state.entries.push(await describeSymlink(state.root, absolute, path));
  else if (metadata.value.isDirectory()) {
    if (current.depth < state.limits.maxDepth) {
      state.entries.push({ status: "read", kind: "directory", path });
      directories.push({ path: absolute, depth: current.depth + 1 });
    } else {
      state.entries.push(
        entryFailure(path, "directory", "limit", "Directory exceeds maxDepth"),
      );
      state.truncated = true;
    }
  } else if (!metadata.value.isFile())
    state.entries.push(
      entryFailure(
        path,
        "other",
        "unsupported",
        "Entry is not a regular file",
        safeSize(metadata.value.size),
      ),
    );
  else await processFileEntry(state, absolute, path, metadata.value);
  return { ok: true, value: undefined };
};

const processFileEntry = async (
  state: TraversalState,
  absolute: string,
  path: string,
  metadata: BigStats,
): Promise<void> => {
  const remaining = state.limits.maxBytes - state.bytesRead;
  if (metadata.size > BigInt(remaining)) {
    state.entries.push(
      entryFailure(
        path,
        "file",
        "limit",
        "File exceeds remaining maxBytes",
        safeSize(metadata.size),
      ),
    );
    state.truncated = true;
    return;
  }
  const result = await readStableFile({
    root: state.root,
    rootIdentity: state.rootIdentity,
    absolute,
    path,
    expected: metadata,
    remaining,
    ...(state.signal === undefined ? {} : { signal: state.signal }),
  });
  if (result.status === "read" && result.kind === "file")
    state.bytesRead += result.bytes.byteLength;
  else if (result.status === "failed" && result.code === "limit")
    state.truncated = true;
  state.entries.push(result);
};

const describeSymlink = async (
  root: string,
  absolute: string,
  path: string,
): Promise<ReferenceSourceEntry> => {
  try {
    const rawTarget = await readlink(absolute);
    const lexicalTarget = resolve(dirname(absolute), rawTarget);
    if (!withinRoot(root, lexicalTarget))
      return {
        status: "read",
        kind: "symlink",
        path,
        target: "<outside-root>",
        targetState: "external",
      };
    try {
      const canonicalTarget = await realpath(lexicalTarget);
      return withinRoot(root, canonicalTarget)
        ? {
            status: "read",
            kind: "symlink",
            path,
            target: pathFromRoot(root, canonicalTarget),
            targetState: "internal",
          }
        : {
            status: "read",
            kind: "symlink",
            path,
            target: "<outside-root>",
            targetState: "external",
          };
    } catch {
      return {
        status: "read",
        kind: "symlink",
        path,
        target: pathFromRoot(root, lexicalTarget),
        targetState: "missing",
      };
    }
  } catch {
    return entryFailure(
      path,
      "symlink",
      "io",
      "Symbolic link target could not be read",
    );
  }
};

const applyExclusion = (
  shouldExclude: ((path: string) => boolean) | undefined,
  path: string,
): { readonly ok: true; readonly value: boolean } | { readonly ok: false } => {
  try {
    return { ok: true, value: shouldExclude?.(path) === true };
  } catch {
    return { ok: false };
  }
};

const reserveEntry = (state: TraversalState): boolean => {
  if (state.filesSeen < state.limits.maxEntries) {
    state.filesSeen += 1;
    return true;
  }
  state.truncated = true;
  state.stopped = true;
  return false;
};

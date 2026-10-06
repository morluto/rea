import { readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  cancelled,
  entryFailure,
  filesystemFailureDetail,
  safeSize,
} from "./ReferenceSourceReaderErrors.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { pathFromRoot } from "./ReferenceSourceReaderPaths.js";
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
    state.signal,
  );
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
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
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
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
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
  const after = await validateDirectory(
    state.root,
    state.rootIdentity,
    current.path,
    state.signal,
  );
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
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
  if (current.path !== state.root)
    state.entries.push({
      status: "read",
      kind: "directory",
      path: pathFromRoot(state.root, current.path),
    });
  const directories: PendingDirectory[] = [];
  for (const name of names.value) {
    const result = await processEntry(state, current, name, directories);
    if (!result.ok) return result;
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
    return {
      ok: true,
      value: (await readdir(path)).sort(compareUnicodeCodePoints),
    };
  } catch (cause: unknown) {
    const message = filesystemFailureDetail(
      cause,
      "Directory could not be read",
    );
    if (message === undefined) throw cause;
    return { ok: false, message };
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
  } catch (cause: unknown) {
    const message = filesystemFailureDetail(
      cause,
      "Entry metadata could not be read",
    );
    if (message === undefined) throw cause;
    return { ok: false, message };
  }
};

const processEntry = async (
  state: TraversalState,
  current: PendingDirectory,
  name: string,
  directories: PendingDirectory[],
): Promise<ReferenceSourceResult<undefined>> => {
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
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
  const metadata = await readMetadata(absolute);
  if (isAborted(state.signal)) return { ok: false, error: cancelled() };
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
    state.entries.push(
      await describeSymlink(state.root, absolute, path, state.signal),
    );
  else if (metadata.value.isDirectory()) {
    directories.push({ path: absolute });
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
  const result = await readStableFile({
    root: state.root,
    rootIdentity: state.rootIdentity,
    absolute,
    path,
    expected: metadata,
    ...(state.signal === undefined ? {} : { signal: state.signal }),
  });
  if (result.status === "read" && result.kind === "file")
    state.bytesRead += result.bytes.byteLength;
  state.entries.push(result);
};

const describeSymlink = async (
  root: string,
  absolute: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReferenceSourceEntry> => {
  try {
    const rawTarget = await readlink(absolute);
    const lexicalTarget = resolve(dirname(absolute), rawTarget);
    if (!isPathWithinRoot(root, lexicalTarget))
      return {
        status: "read",
        kind: "symlink",
        path,
        target: lexicalTarget,
        targetState: "external",
      };
    try {
      const canonicalTarget = await realpath(lexicalTarget);
      return isPathWithinRoot(root, canonicalTarget)
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
            target: canonicalTarget,
            targetState: "external",
          };
    } catch (cause: unknown) {
      if (isAborted(signal))
        return entryFailure(
          path,
          "symlink",
          "cancelled",
          "Symlink inspection cancelled",
        );
      const code =
        cause instanceof Error ? Reflect.get(cause, "code") : undefined;
      if (code !== "ENOENT") {
        const message = filesystemFailureDetail(
          cause,
          "Symbolic link target could not be resolved",
        );
        if (message === undefined) throw cause;
        return entryFailure(path, "symlink", "io", message);
      }
      const missingOutsideRoot = !isPathWithinRoot(root, lexicalTarget);
      return {
        status: "read",
        kind: "symlink",
        path,
        target: missingOutsideRoot
          ? lexicalTarget
          : pathFromRoot(root, lexicalTarget),
        targetState: "missing",
      };
    }
  } catch (cause: unknown) {
    if (isAborted(signal))
      return entryFailure(
        path,
        "symlink",
        "cancelled",
        "Symlink inspection cancelled",
      );
    const message = filesystemFailureDetail(
      cause,
      "Symbolic link target could not be read",
    );
    if (message === undefined) throw cause;
    return entryFailure(path, "symlink", "io", message);
  }
};

const applyExclusion = (
  shouldExclude: ((path: string) => boolean) | undefined,
  path: string,
): { readonly ok: true; readonly value: boolean } | { readonly ok: false } => {
  try {
    return { ok: true, value: shouldExclude?.(path) === true };
  } catch (cause: unknown) {
    // Exclusion predicates are caller-supplied; a throwing predicate fails
    // closed and the caller-visible `{ ok: false }` preserves the rejection
    // without propagating an arbitrary predicate cause.
    void cause;
    return { ok: false };
  }
};

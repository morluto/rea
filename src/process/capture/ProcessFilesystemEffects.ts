import type {
  FilesystemCheckpoint,
  ProcessFilesystemSnapshot,
} from "../../domain/process/processCapture.js";
import { sep } from "node:path";

type UnobservedSubtree = NonNullable<
  ProcessFilesystemSnapshot["coverage"]["unobserved_subtrees"]
>[number];

interface IndexedAbsenceSnapshot {
  readonly completeRoots: ReadonlySet<string>;
  readonly subtreesByPath:
    | ReadonlyMap<
        string,
        { readonly subtree: UnobservedSubtree; readonly index: number }
      >
    | undefined;
}

const indexAbsenceSnapshot = (
  snapshot: ProcessFilesystemSnapshot,
): IndexedAbsenceSnapshot => {
  const subtrees = snapshot.coverage.unobserved_subtrees;
  let subtreesByPath:
    | Map<
        string,
        { readonly subtree: UnobservedSubtree; readonly index: number }
      >
    | undefined;
  if (subtrees !== undefined) {
    subtreesByPath = new Map();
    for (let index = 0; index < subtrees.length; index += 1) {
      const subtree = subtrees[index]!;
      if (!subtreesByPath.has(subtree.path))
        subtreesByPath.set(subtree.path, { subtree, index });
    }
  }
  return {
    completeRoots: new Set(snapshot.completeRoots),
    subtreesByPath,
  };
};

const unobservedAbsenceReason = (
  path: string,
  phase: "before" | "after",
  indexed: IndexedAbsenceSnapshot,
): string | undefined => {
  const alias = path.slice(0, path.indexOf(":"));
  if (!indexed.completeRoots.has(alias))
    return `The ${phase} snapshot did not exhaust path enumeration under ${alias}; absence remains unknown.`;
  const rootPath = `${alias}:.`;
  if (path === rootPath) return undefined;
  const subtreesByPath = indexed.subtreesByPath;
  if (subtreesByPath === undefined)
    return `The ${phase} snapshot has no subtree coverage facts; descendant absence remains unknown.`;
  if (subtreesByPath.size === 0) return undefined;
  let best:
    | { readonly subtree: UnobservedSubtree; readonly index: number }
    | undefined;
  const consider = (
    entry:
      | { readonly subtree: UnobservedSubtree; readonly index: number }
      | undefined,
  ): void => {
    if (entry !== undefined && (best === undefined || entry.index < best.index))
      best = entry;
  };
  if (path.startsWith(`${alias}:`)) consider(subtreesByPath.get(rootPath));
  const exact = subtreesByPath.get(path);
  if (exact?.subtree.reason === "observer_owned") consider(exact);
  for (let cut = path.lastIndexOf(sep); cut !== -1;) {
    consider(subtreesByPath.get(path.slice(0, cut)));
    cut = cut > 0 ? path.lastIndexOf(sep, cut - 1) : -1;
  }
  return best === undefined
    ? undefined
    : `The ${phase} snapshot did not observe the subtree at ${best.subtree.path} (${best.subtree.reason}); descendant absence remains unknown.`;
};

/** Classify effects only from observed path absence, metadata, and content hashes. */
export const classifyFilesystemEffects = (
  before: ProcessFilesystemSnapshot,
  after: ProcessFilesystemSnapshot,
): FilesystemCheckpoint["effects"] => {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  let beforeIndexed: IndexedAbsenceSnapshot | undefined;
  let afterIndexed: IndexedAbsenceSnapshot | undefined;
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort()
    .map((path) => {
      const beforeFile = beforeByPath.get(path) ?? null;
      const afterFile = afterByPath.get(path) ?? null;
      const reason =
        beforeFile === null
          ? unobservedAbsenceReason(
              path,
              "before",
              (beforeIndexed ??= indexAbsenceSnapshot(before)),
            )
          : afterFile === null
            ? unobservedAbsenceReason(
                path,
                "after",
                (afterIndexed ??= indexAbsenceSnapshot(after)),
              )
            : undefined;
      if (reason !== undefined)
        return {
          path,
          status: "unknown",
          before: beforeFile,
          after: afterFile,
          reason,
        } as const;
      if (beforeFile === null) {
        if (afterFile === null)
          throw new TypeError(`Filesystem effect ${path} has no file state`);
        return {
          path,
          status: "created",
          before: null,
          after: afterFile,
        } as const;
      }
      if (afterFile === null)
        return {
          path,
          status: "deleted",
          before: beforeFile,
          after: null,
        } as const;
      const metadataChanged =
        beforeFile.type !== afterFile.type ||
        beforeFile.mode !== afterFile.mode ||
        beforeFile.size !== afterFile.size;
      const beforeTarget =
        beforeFile.type === "symlink" ? beforeFile.symlink_target_hex : null;
      const afterTarget =
        afterFile.type === "symlink" ? afterFile.symlink_target_hex : null;
      if (
        !metadataChanged &&
        beforeFile.type === "file" &&
        afterFile.type === "file" &&
        (beforeFile.sha256 === null || afterFile.sha256 === null)
      )
        return {
          path,
          status: "unknown",
          before: beforeFile,
          after: afterFile,
          reason:
            "A file content hash is unavailable in at least one snapshot; matching metadata does not establish unchanged contents.",
        } as const;
      return {
        path,
        status:
          metadataChanged ||
          beforeTarget !== afterTarget ||
          beforeFile.sha256 !== afterFile.sha256
            ? "modified"
            : "unchanged",
        before: beforeFile,
        after: afterFile,
      } as const;
    });
};

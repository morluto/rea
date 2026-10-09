import type {
  FileState,
  FilesystemCheckpoint,
  ProcessFilesystemSnapshot,
} from "../../domain/process/processCapture.js";
import { sep } from "node:path";

const unobservedAbsenceReason = (
  path: string,
  phase: "before" | "after",
  completeRoots: ReadonlySet<string>,
  filesByPath: ReadonlyMap<string, FileState>,
): string | undefined => {
  const alias = path.slice(0, path.indexOf(":"));
  if (!completeRoots.has(alias))
    return `The ${phase} snapshot did not exhaust path enumeration under ${alias}; absence remains unknown.`;
  const rootPath = `${alias}:.`;
  if (path !== rootPath && filesByPath.get(rootPath)?.type === "symlink")
    return `The ${phase} snapshot did not follow the symbolic link at ${rootPath}; descendant absence remains unknown.`;
  for (
    let index = path.lastIndexOf(sep);
    index > 0;
    index = path.lastIndexOf(sep, index - 1)
  ) {
    const parent = path.slice(0, index);
    if (filesByPath.get(parent)?.type === "symlink")
      return `The ${phase} snapshot did not follow the symbolic link at ${parent}; descendant absence remains unknown.`;
  }
  return undefined;
};

/** Classify effects only from observed path absence, metadata, and content hashes. */
export const classifyFilesystemEffects = (
  before: ProcessFilesystemSnapshot,
  after: ProcessFilesystemSnapshot,
): FilesystemCheckpoint["effects"] => {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const beforeCompleteRoots = new Set(before.completeRoots);
  const afterCompleteRoots = new Set(after.completeRoots);
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
              beforeCompleteRoots,
              beforeByPath,
            )
          : afterFile === null
            ? unobservedAbsenceReason(
                path,
                "after",
                afterCompleteRoots,
                afterByPath,
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
        beforeFile.size !== afterFile.size ||
        beforeFile.symlink_target !== afterFile.symlink_target;
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
          metadataChanged || beforeFile.sha256 !== afterFile.sha256
            ? "modified"
            : "unchanged",
        before: beforeFile,
        after: afterFile,
      } as const;
    });
};

import type {
  FileState,
  FilesystemCheckpoint,
} from "../../domain/process/processCapture.js";

/** Classify path-stable filesystem effects between two bounded states. */
export const classifyFilesystemEffects = (
  before: readonly FileState[],
  after: readonly FileState[],
): FilesystemCheckpoint["effects"] => {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort()
    .map((path) => {
      const beforeFile = beforeByPath.get(path) ?? null;
      const afterFile = afterByPath.get(path) ?? null;
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
      return {
        path,
        status:
          JSON.stringify(beforeFile) === JSON.stringify(afterFile)
            ? "unchanged"
            : "modified",
        before: beforeFile,
        after: afterFile,
      } as const;
    });
};

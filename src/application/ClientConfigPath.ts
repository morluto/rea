import { lstat, realpath } from "node:fs/promises";

interface ClientConfigPathStats {
  readonly uid?: number;
  isFile?(): boolean;
  isSymbolicLink(): boolean;
}

interface ClientConfigPathFileSystem {
  lstat(path: string): Promise<ClientConfigPathStats>;
  realpath?(path: string): Promise<string>;
}

const systemFileSystem: ClientConfigPathFileSystem = { lstat, realpath };

/**
 * Resolve an existing, user-owned config symlink to one stable transaction
 * path. Missing regular paths remain eligible for first-run creation.
 */
export const resolveClientConfigTransactionPath = async (
  requestedPath: string,
  fileSystem: ClientConfigPathFileSystem = systemFileSystem,
): Promise<string | undefined> => {
  let requestedStats: ClientConfigPathStats;
  try {
    requestedStats = await fileSystem.lstat(requestedPath);
  } catch (cause: unknown) {
    return isMissing(cause) ? requestedPath : undefined;
  }
  if (!requestedStats.isSymbolicLink()) return requestedPath;

  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    currentUid === undefined ||
    requestedStats.uid !== currentUid ||
    fileSystem.realpath === undefined
  )
    return undefined;

  try {
    const canonicalPath = await fileSystem.realpath(requestedPath);
    const targetStats = await fileSystem.lstat(canonicalPath);
    return targetStats.isFile?.() === true && targetStats.uid === currentUid
      ? canonicalPath
      : undefined;
  } catch {
    return undefined;
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

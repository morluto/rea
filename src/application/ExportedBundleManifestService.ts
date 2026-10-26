import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import {
  type CreateExportedBundleManifestInput,
  createExportedBundleManifest,
  EXPORTED_BUNDLE_MANIFEST_FILENAME,
  type ExportedBundleManifest,
  type ExportedBundleVerificationReport,
  type ObservedBundleFileSystemEntry,
  serializeExportedBundleManifest,
  verifyExportedBundleManifest,
} from "../domain/exportedBundleManifest.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

let tempManifestCounter = 0;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const inspectRegularFileSnapshot = async (
  candidateAbsolutePath: string,
  relativePath: string,
  initialStats: Awaited<ReturnType<typeof lstat>>,
): Promise<ObservedBundleFileSystemEntry> => {
  const fileBytes = await readFile(candidateAbsolutePath);
  const postStats = await lstat(candidateAbsolutePath);
  if (
    postStats.isSymbolicLink() ||
    !postStats.isFile() ||
    postStats.ino !== initialStats.ino ||
    postStats.size !== fileBytes.byteLength
  ) {
    return {
      relative_path: relativePath,
      kind: "other",
      sha256: null,
      bytes: null,
    };
  }
  return {
    relative_path: relativePath,
    kind: "file",
    sha256: sha256Hex(fileBytes),
    bytes: fileBytes.byteLength,
  };
};

/**
 * Passively inspect an exported bundle directory tree without following
 * symlinks or executing any bundled artifacts.
 */
export const collectExportedBundleDirectoryEntries = async (
  directoryPath: string,
): Promise<readonly ObservedBundleFileSystemEntry[]> => {
  const rootPath = resolve(directoryPath);
  const rootStats = await lstat(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new EvidenceIntegrityError(
      `Exported bundle root must be a regular directory (not a symlink or file): ${JSON.stringify(directoryPath)}`,
    );
  }

  const collected: ObservedBundleFileSystemEntry[] = [];

  const walk = async (
    currentAbsoluteDir: string,
    relativePrefix: string,
  ): Promise<void> => {
    const dirents = await readdir(currentAbsoluteDir, { withFileTypes: true });
    if (dirents.length === 0 && relativePrefix.length > 0) {
      collected.push({
        relative_path: relativePrefix,
        kind: "directory",
        sha256: null,
        bytes: null,
      });
      return;
    }

    const sortedNames = dirents
      .map((dirent) => dirent.name)
      .sort(compareUnicodeCodePoints);

    for (const name of sortedNames) {
      const relativePath =
        relativePrefix.length === 0 ? name : `${relativePrefix}/${name}`;
      if (relativePath === EXPORTED_BUNDLE_MANIFEST_FILENAME) continue;

      const candidateAbsolutePath = join(currentAbsoluteDir, name);
      if (!isPathWithinRoot(rootPath, candidateAbsolutePath)) {
        collected.push({
          relative_path: relativePath,
          kind: "other",
          sha256: null,
          bytes: null,
        });
        continue;
      }

      const entryStats = await lstat(candidateAbsolutePath);
      if (entryStats.isSymbolicLink()) {
        collected.push({
          relative_path: relativePath,
          kind: "symlink",
          sha256: null,
          bytes: null,
        });
        continue;
      }

      if (entryStats.isDirectory()) {
        await walk(candidateAbsolutePath, relativePath);
        continue;
      }

      if (!entryStats.isFile()) {
        collected.push({
          relative_path: relativePath,
          kind: "other",
          sha256: null,
          bytes: null,
        });
        continue;
      }

      collected.push(
        await inspectRegularFileSnapshot(
          candidateAbsolutePath,
          relativePath,
          entryStats,
        ),
      );
    }
  };

  await walk(rootPath, "");
  return collected;
};

export interface GenerateExportedBundleDirectoryManifestOptions {
  readonly bundle_kind: CreateExportedBundleManifestInput["bundle_kind"];
  readonly provenance?: CreateExportedBundleManifestInput["provenance"];
  readonly limitations?: readonly string[];
  readonly roleByRelativePath?: Readonly<Record<string, string | null>>;
  readonly writeManifestFile?: boolean;
}

const lookupEntryRole = (
  roleMap: Readonly<Record<string, string | null>> | undefined,
  relativePath: string,
): string | null =>
  roleMap !== undefined && Object.hasOwn(roleMap, relativePath)
    ? (roleMap[relativePath] ?? null)
    : null;

/**
 * Scan an exported bundle directory and build a verifiable manifest.
 * Fails closed if the directory contains symlinks, empty directories, or non-regular files.
 */
export const generateExportedBundleDirectoryManifest = async (
  directoryPath: string,
  options: GenerateExportedBundleDirectoryManifestOptions,
): Promise<ExportedBundleManifest> => {
  const observedEntries =
    await collectExportedBundleDirectoryEntries(directoryPath);
  const entries: {
    readonly relative_path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly role: string | null;
  }[] = [];

  for (const observed of observedEntries) {
    if (
      observed.kind !== "file" ||
      typeof observed.sha256 !== "string" ||
      typeof observed.bytes !== "number"
    ) {
      throw new EvidenceIntegrityError(
        `Cannot generate exported bundle manifest: entry ${JSON.stringify(observed.relative_path)} is not a regular file (${String(observed.kind)})`,
      );
    }
    entries.push({
      relative_path: observed.relative_path,
      sha256: observed.sha256,
      bytes: observed.bytes,
      role: lookupEntryRole(options.roleByRelativePath, observed.relative_path),
    });
  }

  const manifest = createExportedBundleManifest({
    bundle_kind: options.bundle_kind,
    entries,
    ...(options.provenance === undefined
      ? {}
      : { provenance: options.provenance }),
    ...(options.limitations === undefined
      ? {}
      : { limitations: options.limitations }),
  });

  if (options.writeManifestFile === true) {
    const rootPath = resolve(directoryPath);
    const manifestPath = join(rootPath, EXPORTED_BUNDLE_MANIFEST_FILENAME);
    tempManifestCounter += 1;
    const tempPath = join(
      rootPath,
      `.${EXPORTED_BUNDLE_MANIFEST_FILENAME}.tmp-${String(process.pid)}-${String(Date.now())}-${String(tempManifestCounter)}`,
    );
    const serialized = serializeExportedBundleManifest(manifest);
    try {
      await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
      await rename(tempPath, manifestPath);
    } catch (cause: unknown) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  return manifest;
};

/**
 * Verify an exported bundle directory against its `rea-bundle-manifest.json`
 * (or an explicit manifest object/file) without executing any bundled artifacts.
 */
export const verifyExportedBundleDirectory = async (
  directoryPath: string,
  options?: {
    readonly manifest?: unknown;
    readonly manifestFilePath?: string;
  },
): Promise<ExportedBundleVerificationReport> => {
  const rootPath = resolve(directoryPath);
  const observedEntries = await collectExportedBundleDirectoryEntries(rootPath);
  let manifestInput: unknown = options?.manifest;

  if (manifestInput === undefined) {
    const targetManifestPath =
      options?.manifestFilePath ??
      join(rootPath, EXPORTED_BUNDLE_MANIFEST_FILENAME);
    try {
      const manifestStats = await lstat(targetManifestPath);
      if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
        return verifyExportedBundleManifest(null, observedEntries);
      }
      const rawJson = await readFile(targetManifestPath, "utf8");
      manifestInput = JSON.parse(rawJson) as unknown;
    } catch {
      return verifyExportedBundleManifest(null, observedEntries);
    }
  }

  return verifyExportedBundleManifest(manifestInput, observedEntries);
};

import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";

import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "../ArtifactHash.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../../domain/zipPackageFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { HashResult } from "../ArtifactHash.js";
import { hashStableRootArtifactHandle } from "./hashStableRootArtifact.js";

interface RootClassification {
  readonly format: ArtifactOccurrence["artifact_format"];
  readonly digest: HashResult | null;
}

type RootInventoryClassification = RootClassification & {
  readonly rootSource: StableRegularFileDescriptor | undefined;
};

/** Classify and hash one file root through the same stable open descriptor. */
export const classifyAndHashRoot = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  signal?: AbortSignal,
): Promise<RootClassification> => {
  const result = await classifyAndHashRootForInventory(
    path,
    directory,
    expectedMetadata,
    signal,
  );
  try {
    return { format: result.format, digest: result.digest };
  } finally {
    await result.rootSource?.handle.close();
  }
};

/** Classify a root and retain its admitted ZIP descriptor for child inventory. */
export const classifyAndHashRootForInventory = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  signal?: AbortSignal,
): Promise<RootInventoryClassification> => {
  if (directory)
    return { format: "directory", digest: null, rootSource: undefined };
  const handle = await openRootFile(path, signal);
  let transferHandle = false;
  try {
    const initial = await handle.stat();
    if (!sameRegularFileState(expectedMetadata, initial))
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed before inventory: ${path}`,
      );
    const format = await classifyRootFormat(path, handle);
    const digest = await hashStableRootArtifactHandle(
      path,
      handle,
      initial,
      signal,
    );
    const retainSource = isZipFormat(format) || format === "mach-o-universal";
    if (retainSource) transferHandle = true;
    return {
      format,
      digest,
      rootSource: retainSource ? { handle, initial } : undefined,
    };
  } finally {
    if (!transferHandle) await handle.close();
  }
};

const isZipFormat = (format: ArtifactOccurrence["artifact_format"]): boolean =>
  format === "zip" ||
  format === "ipa" ||
  format === "apk" ||
  format === "msix" ||
  format === "appx";

const openRootFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<FileHandle> => {
  try {
    return await openRegularFile(path, { symlinks: "reject", signal });
  } catch (cause: unknown) {
    if (cause instanceof NonRegularFileReadError)
      throw new ArtifactReaderFailure(
        "format",
        `Artifact root is not a regular file: ${path}`,
        { cause },
      );
    throw cause;
  }
};

const classifyRootFormat = async (
  path: string,
  handle: FileHandle,
): Promise<ArtifactOccurrence["artifact_format"]> => {
  const magic = Buffer.alloc(ARTIFACT_CLASSIFICATION_PREFIX_BYTES);
  const observed = await handle.read(magic, 0, magic.length, 0);
  const prefix = magic.subarray(0, observed.bytesRead);
  const lower = path.toLowerCase();
  if (hasZipSignature(prefix)) return zipPackageFormatForPath(lower) ?? "zip";
  if (
    lower.endsWith(".pkg") &&
    prefix.subarray(0, 4).toString("ascii") === "xar!"
  )
    return "pkg";
  if (lower.endsWith(".dmg") && (await hasKolyTrailer(handle))) return "dmg";
  // ASAR is chosen from its header pickle; any other suffix is a role hint.
  return classifyArtifactContent(path, prefix, (await handle.stat()).size)
    .format;
};

const hasKolyTrailer = async (handle: FileHandle): Promise<boolean> => {
  const size = (await handle.stat()).size;
  if (size < 512) return false;
  const trailer = Buffer.alloc(4);
  const read = await handle.read(trailer, 0, trailer.length, size - 512);
  return read.bytesRead === 4 && trailer.toString("ascii") === "koly";
};

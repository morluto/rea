import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

import {
  classifyArtifactBytes,
  classifyArtifactContent,
} from "./ArtifactGraphConstruction.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "../ArtifactHash.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  zipPackageFormatForPath,
} from "../../domain/zipPackageFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { HashResult } from "../ArtifactHash.js";
import { hashStableRootArtifactHandle } from "./hashStableRootArtifact.js";

/** Classify and hash one file root through the same stable open descriptor. */
export const classifyAndHashRoot = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  signal?: AbortSignal,
): Promise<{
  readonly format: ArtifactOccurrence["artifact_format"];
  readonly digest: HashResult | null;
}> => {
  if (directory) return { format: "directory", digest: null };
  const handle = await openRootFile(path, signal);
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
    return { format, digest };
  } finally {
    await handle.close();
  }
};

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
  if (lower.endsWith(".asar") && hasAsarHeader(prefix)) return "asar";
  if (
    lower.endsWith(".pkg") &&
    prefix.subarray(0, 4).toString("ascii") === "xar!"
  )
    return "pkg";
  if (lower.endsWith(".dmg") && (await hasKolyTrailer(handle))) return "dmg";
  const size = (await handle.stat()).size;
  const format = classifyArtifactContent(path, prefix, size).format;
  // Path suffixes stay role hints for nested members. A root whose container
  // magic did not match is classified from the bytes that were read.
  if (format === "asar" || format === "pkg" || format === "dmg")
    return classifyArtifactBytes(prefix, size);
  return format;
};

/**
 * Electron ASAR starts with a size pickle whose payload is one uint32, then
 * a header pickle whose payload begins with a JSON object.
 */
const hasAsarHeader = (prefix: Buffer): boolean => {
  if (prefix.length < 16 || prefix.readUInt32LE(0) !== 4) return false;
  const headerSize = prefix.readUInt32LE(4);
  const payloadSize = prefix.readUInt32LE(8);
  if (headerSize < 16 || payloadSize !== headerSize - 4) return false;
  const stringLength = prefix.readUInt32LE(12);
  return (
    stringLength >= 2 && stringLength <= payloadSize - 4 && prefix[16] === 0x7b
  );
};

const hasKolyTrailer = async (handle: FileHandle): Promise<boolean> => {
  const size = (await handle.stat()).size;
  if (size < 512) return false;
  const trailer = Buffer.alloc(4);
  const read = await handle.read(trailer, 0, trailer.length, size - 512);
  return read.bytesRead === 4 && trailer.toString("ascii") === "koly";
};

import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "../ArtifactHash.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  isZipPackageFormat,
  zipPackageFormatForPath,
  type ZipPackageFormat,
} from "../../domain/zipPackageFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { ArtifactResourceOwner } from "../ArtifactResourceScope.js";
import type { HashResult } from "../ArtifactHash.js";
import {
  hashStableRootArtifactHandle,
  openRootArtifact,
} from "./hashStableRootArtifact.js";
import type { ArtifactInventoryOptions } from "./types.js";

interface RootClassification {
  readonly format: ArtifactOccurrence["artifact_format"];
  readonly digest: HashResult | null;
}

type RootInventoryClassification = RootClassification & {
  readonly rootSource: RootInventorySource | undefined;
};

/** The admitted descriptor and the single owner that can confirm its close. */
export interface RootInventorySource extends StableRegularFileDescriptor {
  readonly owner: OwnedFileHandle;
}

/** Classify and hash one file root through the same stable open descriptor. */
export const classifyAndHashRoot = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<ArtifactInventoryOptions, "resourceScope" | "signal">,
): Promise<RootClassification> => {
  return options.resourceScope.run(async () => {
    const result = await classifyAndHashRootForInventory(
      path,
      directory,
      expectedMetadata,
      options,
    );
    const rootSource = result.rootSource;
    if (rootSource !== undefined) {
      const owner: ArtifactResourceOwner = {
        kind: "file-handle",
        handle: rootSource.owner,
        resource: `root artifact descriptor for ${path}`,
      };
      const cleanupAttempt = await options.resourceScope.release(owner);
      if (cleanupAttempt.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          cleanupAttempt.cause,
          ArtifactReaderFailure.cleanupObservation(
            cleanupAttempt.cause,
            owner.resource,
          ),
        );
    }
    return { format: result.format, digest: result.digest };
  });
};

/** Classify a root and retain its admitted ZIP descriptor for child inventory. */
export const classifyAndHashRootForInventory = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<ArtifactInventoryOptions, "resourceScope" | "signal">,
): Promise<RootInventoryClassification> => {
  if (directory)
    return { format: "directory", digest: null, rootSource: undefined };
  const ownedHandle = await openRootArtifact(
    path,
    options.resourceScope,
    options.signal,
  );
  const handle = ownedHandle.handle;
  const owner: ArtifactResourceOwner = {
    kind: "file-handle",
    handle: ownedHandle,
    resource: `root artifact descriptor for ${path}`,
  };
  let outcome:
    | {
        readonly kind: "completed";
        readonly value: RootInventoryClassification;
      }
    | { readonly kind: "failed"; readonly cause: unknown };
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
      options.signal,
    );
    const retainSource =
      isZipPackageFormat(format) || format === "mach-o-universal";
    outcome = {
      kind: "completed",
      value: {
        format,
        digest,
        rootSource: retainSource
          ? { handle, initial, owner: ownedHandle }
          : undefined,
      },
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (outcome.kind === "failed" || outcome.value.rootSource === undefined) {
    const cleanupAttempt = await options.resourceScope.release(owner);
    if (cleanupAttempt.kind === "failed")
      throw ArtifactReaderFailure.withCleanup(
        outcome.kind === "failed" ? outcome.cause : cleanupAttempt.cause,
        ArtifactReaderFailure.cleanupObservation(
          cleanupAttempt.cause,
          owner.resource,
        ),
      );
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

const classifyRootFormat = async (
  path: string,
  handle: FileHandle,
): Promise<ArtifactOccurrence["artifact_format"]> => {
  const magic = Buffer.alloc(ARTIFACT_CLASSIFICATION_PREFIX_BYTES);
  const observed = await handle.read(magic, 0, magic.length, 0);
  const prefix = magic.subarray(0, observed.bytesRead);
  const lower = path.toLowerCase();
  if (hasZipSignature(prefix)) return zipRootPackageFormat(lower);
  if (
    lower.endsWith(".pkg") &&
    prefix.subarray(0, 4).equals(Buffer.from("xar!"))
  )
    return "pkg";
  if (lower.endsWith(".dmg") && (await hasKolyTrailer(handle))) return "dmg";
  // ASAR is chosen from its header pickle; any other suffix is a role hint.
  return classifyArtifactContent(path, prefix, (await handle.stat()).size)
    .format;
};

/** App Pack is a verified ZIP root role; nested .app members retain their observed format. */
const zipRootPackageFormat = (lower: string): ZipPackageFormat =>
  lower.endsWith(".app")
    ? "app-pack"
    : (zipPackageFormatForPath(lower) ?? "zip");

const hasKolyTrailer = async (handle: FileHandle): Promise<boolean> => {
  const size = (await handle.stat()).size;
  if (size < 512) return false;
  const trailer = Buffer.alloc(4);
  const read = await handle.read(trailer, 0, trailer.length, size - 512);
  return read.bytesRead === 4 && trailer.equals(Buffer.from("koly"));
};

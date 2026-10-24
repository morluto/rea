import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import { locateGodotPck } from "../GodotPckLocation.js";
import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

import { containsPyInstallerArchive } from "../pyinstaller/CArchiveLayout.js";
import { decodeNodeSeaBlob } from "../nodeSea/NodeSeaBlob.js";
import { locateNodeSea, readNodeSeaBlob } from "../nodeSea/NodeSeaLocation.js";
import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { claimsExecutableHeader } from "../../domain/binaryTarget.js";
import { createArtifactClassificationProbe } from "../ArtifactClassificationProbe.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  locateTrailingZipArchive,
  isZipPackageFormat,
  zipRootPackageFormat,
} from "../../domain/zipPackageFormat.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import type { ArtifactResourceOwner } from "../ArtifactResourceScope.js";
import type { HashResult } from "../ArtifactHash.js";
import {
  hashStableRootArtifactHandle,
  openRootArtifact,
} from "./hashStableRootArtifact.js";
import type { ArtifactInventoryOptions } from "./types.js";
import { readMachoHeaderPrefixFacts } from "../../domain/apple/machoContainer.js";
import {
  observeMzWindowsHeader,
  type MzWindowsHeaderSignatureEvidence,
} from "../../domain/dosMz.js";
import type { ArtifactClassificationEvidence } from "../ArtifactClassificationProbe.js";

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
        throw options.resourceScope.cleanupFailure({ kind: "completed" }, [
          cleanupAttempt,
        ]);
    }
    return { format: result.format, digest: result.digest };
  });
};

/** Classify a root and retain its admitted ZIP descriptor for child inventory. */
export const classifyAndHashRootForInventory = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<
    ArtifactInventoryOptions,
    "resourceScope" | "signal" | "asarHeaderAdmission"
  >,
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
    const format = await classifyRootFormat(
      path,
      handle,
      options.signal,
      options.asarHeaderAdmission,
    );
    const digest = await hashStableRootArtifactHandle(
      path,
      handle,
      initial,
      options.signal,
    );
    const retainSource =
      isZipPackageFormat(format) ||
      format === "mach-o-universal" ||
      format === "godot-pck" ||
      format === "pyinstaller" ||
      format === "node-sea";
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
      throw options.resourceScope.cleanupFailure(outcome, [cleanupAttempt]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

const classifyRootFormat = async (
  path: string,
  handle: FileHandle,
  signal?: AbortSignal,
  asarHeaderAdmission?: AsarHeaderAdmission,
): Promise<ArtifactOccurrence["artifact_format"]> => {
  const probe = createArtifactClassificationProbe(asarHeaderAdmission);
  const chunk = Buffer.alloc(64 * 1024);
  while (probe.length < probe.limit) {
    abortIfNeeded(signal);
    const read = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, probe.limit - probe.length),
      probe.length,
    );
    abortIfNeeded(signal);
    if (read.bytesRead === 0) break;
    probe.write(chunk.subarray(0, read.bytesRead));
  }
  const archiveBytes = (await handle.stat()).size;
  const evidence = probe.finish(archiveBytes);
  abortIfNeeded(signal);
  const lower = path.toLowerCase();
  if (hasZipSignature(evidence.prefix)) return zipRootPackageFormat(lower);
  if (
    lower.endsWith(".pkg") &&
    evidence.prefix.subarray(0, 4).equals(Buffer.from("xar!"))
  )
    return "pkg";
  if (
    lower.endsWith(".dmg") &&
    (await hasKolyTrailer(handle, archiveBytes, signal))
  )
    return "dmg";
  if (await locateGodotPck(handle, archiveBytes, signal, evidence.prefix))
    return "godot-pck";
  const fatEvidence = await readRootFatSliceHeaders(handle, evidence, signal);
  const mzWindowsHeaderSignature = await readRootMzWindowsHeaderSignature(
    handle,
    fatEvidence,
    archiveBytes,
    signal,
  );
  const classificationEvidence =
    mzWindowsHeaderSignature === undefined
      ? fatEvidence
      : { ...fatEvidence, mzWindowsHeaderSignature };
  const format = classifyArtifactContent(
    path,
    classificationEvidence,
    archiveBytes,
  ).format;
  // Only bytes no other format claims may lead a located ZIP, so an
  // executable with an appended archive keeps its executable classification.
  if (
    (format === "file" || format === "unknown") &&
    !claimsExecutableHeader(evidence.prefix, archiveBytes) &&
    (await locateTrailingZipArchive(archiveBytes, async (position, length) => {
      abortIfNeeded(signal);
      const bytes = Buffer.alloc(length);
      const read = await handle.read(bytes, 0, length, position);
      abortIfNeeded(signal);
      return bytes.subarray(0, read.bytesRead);
    })) !== undefined
  )
    return zipRootPackageFormat(lower);
  if (["elf", "pe", "mach-o", "mach-o-universal"].includes(format)) {
    const sea = await locateNodeSea(handle, archiveBytes, signal);
    abortIfNeeded(signal);
    if (sea !== undefined) {
      decodeNodeSeaBlob(
        await readNodeSeaBlob(handle, sea, archiveBytes, signal),
      );
      return "node-sea";
    }
    const packaged = await containsPyInstallerArchive(
      handle,
      archiveBytes,
      signal,
    );
    abortIfNeeded(signal);
    if (packaged) return "pyinstaller";
  }
  return format;
};

/** Read exact FAT header windows missed by the bounded prefix probe. */
const readRootFatSliceHeaders = async (
  handle: FileHandle,
  evidence: ArtifactClassificationEvidence,
  signal?: AbortSignal,
): Promise<ArtifactClassificationEvidence> => {
  const existing = evidence.fatSliceHeaders;
  if (existing === undefined) return evidence;
  const { header } = existing;
  const sliceHeadersByOffset = new Map(existing.sliceHeadersByOffset);
  for (let index = 0; index < header.slices.length; index += 1) {
    const slice = header.slices[index];
    const observed =
      slice === undefined ? undefined : sliceHeadersByOffset.get(slice.offset);
    if (
      slice === undefined ||
      header.rangeIssues[index] !== null ||
      slice.size < 4 ||
      (observed !== undefined && observed.magic !== null)
    )
      continue;
    const headerLength = Math.min(12, slice.size);
    const thinHeader = Buffer.alloc(headerLength);
    let bytesRead = 0;
    while (bytesRead < thinHeader.length) {
      abortIfNeeded(signal);
      const read = await handle.read(
        thinHeader,
        bytesRead,
        thinHeader.length - bytesRead,
        slice.offset + bytesRead,
      );
      abortIfNeeded(signal);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    sliceHeadersByOffset.set(
      slice.offset,
      readMachoHeaderPrefixFacts(thinHeader.subarray(0, bytesRead)),
    );
  }
  return { ...evidence, fatSliceHeaders: { header, sliceHeadersByOffset } };
};

/** Read only the missing signature bytes requested by the bounded MZ parser. */
const readRootMzWindowsHeaderSignature = async (
  handle: FileHandle,
  evidence: ArtifactClassificationEvidence,
  fileSize: number,
  signal?: AbortSignal,
): Promise<MzWindowsHeaderSignatureEvidence | undefined> => {
  const observation = observeMzWindowsHeader(evidence.prefix, fileSize);
  if (observation.state !== "signature-needed")
    return evidence.mzWindowsHeaderSignature;
  const { offset } = observation;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= fileSize)
    return evidence.mzWindowsHeaderSignature;

  const window = Buffer.alloc(4);
  const existing =
    evidence.mzWindowsHeaderSignature?.offset === offset
      ? evidence.mzWindowsHeaderSignature.bytes
      : undefined;
  const inline =
    offset < evidence.prefix.length
      ? evidence.prefix.subarray(
          offset,
          Math.min(offset + 4, evidence.prefix.length),
        )
      : undefined;
  const known =
    existing !== undefined &&
    (inline === undefined || existing.length > inline.length)
      ? existing
      : inline;
  known?.copy(window);
  let available = known?.length ?? 0;
  const requiredLength = (): number =>
    available >= 2 && window[0] === 0x50 && window[1] === 0x45 ? 4 : 2;
  while (available < requiredLength() && offset + available < fileSize) {
    abortIfNeeded(signal);
    const length = Math.min(
      requiredLength() - available,
      fileSize - offset - available,
    );
    const chunk = Buffer.alloc(length);
    const read = await handle.read(chunk, 0, length, offset + available);
    abortIfNeeded(signal);
    if (read.bytesRead === 0) break;
    chunk.copy(window, available, 0, read.bytesRead);
    available += read.bytesRead;
  }
  if (available === 0) return undefined;
  return { offset, bytes: window.subarray(0, available) };
};

const hasKolyTrailer = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (size < 512) return false;
  const trailer = Buffer.alloc(4);
  let bytes = 0;
  while (bytes < trailer.length) {
    abortIfNeeded(signal);
    const read = await handle.read(
      trailer,
      bytes,
      trailer.length - bytes,
      size - 512 + bytes,
    );
    abortIfNeeded(signal);
    if (read.bytesRead === 0) return false;
    bytes += read.bytesRead;
  }
  return trailer.equals(Buffer.from("koly"));
};

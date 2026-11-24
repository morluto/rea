import { probeUefiFlashImage } from "../../uefi/UefiFormatProbe.js";
import {
  createCachedPrefixReader,
  readFileHandleRange,
} from "../../filesystem/readFileHandleRange.js";
import {
  artifactOperationCause,
  ArtifactReaderFailure,
  openRootArtifact,
  releaseRootArtifact,
  abortIfNeeded,
  assertArtifactSelectedSource,
} from "../../resources/index.js";
import { nesContainerFormat } from "../../domain/inesContainer.js";
import {
  resolveArtifactReaderLimits,
  type ArtifactReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import type {
  ArtifactReaderAdmission,
  ArtifactFormatAdmission,
} from "../ArtifactReaderAdmission.js";
import {
  locateEspFlashLayout,
  type EspFlashSelection,
} from "../../domain/firmware/espFlashLocation.js";
import { artifactNameForClassification } from "../../domain/artifactNameSelection.js";
import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import {
  ArtifactEmbeddedFormatProbes,
  type ArtifactEmbeddedFormatProbeFacts,
} from "../ArtifactEmbeddedFormatProbes.js";
import type { BunStandaloneProbe } from "../bun/BunModuleGraphLayout.js";
import type { NodeSeaLocation } from "../nodeSea/NodeSeaLocation.js";
import type { PyInstallerCookie } from "../pyinstaller/CArchiveLayout.js";
import {
  assertStableRegularFileIdentity,
  RegularFileChangedError,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

import { decodeNodeSeaBlob } from "../nodeSea/NodeSeaBlob.js";
import { readNodeSeaBlob } from "../nodeSea/NodeSeaLocation.js";
import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";
import {
  MAX_PE_OPTIONAL_HEADER_BYTES,
  PE_RECORD_HEADER_BYTES,
  claimsExecutableHeader,
} from "../../domain/binaryTarget.js";
import { createArtifactClassificationProbe } from "../ArtifactClassificationProbe.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  hasZipSignature,
  hasTrailingZipArchive,
  zipRootPackageFormat,
} from "../../domain/zipPackageFormat.js";
import { artifactFormatDescriptor } from "../artifactFormats.js";
import { BinaryReader, hasXarMagic } from "../../domain/binaryContainer.js";
import {
  classifyStableRootArtifactHandle,
  type HashResult,
} from "../ArtifactHash.js";
import type { ArtifactInventoryOptions } from "./types.js";
import { readFatSliceHeaders } from "../../domain/apple/machoContainer.js";
import { hasDiskImageSignature } from "../../domain/apple/diskImageFormat.js";
import {
  DFUSE_SUFFIX_BYTES,
  hasDfuSePrefix,
} from "../../domain/firmware/dfuse.js";
import {
  observeMzWindowsHeader,
  type MzWindowsHeaderRecordEvidence,
} from "../../domain/dosMz.js";
import type { ArtifactClassificationEvidence } from "../ArtifactClassificationProbe.js";
import {
  ISO9660_DESCRIPTOR_OFFSET,
  ISO9660_RECOGNITION_BYTES,
  ISO9660_SIGNATURE_BYTES,
} from "../../domain/iso9660/iso9660Structures.js";

interface RootClassification {
  readonly format: ArtifactOccurrence["artifact_format"];
  readonly digest: HashResult | null;
}

type RootInventoryClassification = RootClassification & {
  readonly rootSource: RootInventorySource | undefined;
  readonly readerAdmission: ArtifactReaderAdmission | undefined;
  readonly recognitionLimitations?: readonly string[];
};

/** The admitted descriptor and the single owner that can confirm its close. */
export interface RootInventorySource extends StableRegularFileDescriptor {
  readonly owner: OwnedFileHandle;
}

/** Classify a root and retain its admitted source and format facts for child inventory. */
export const classifyAndHashRootForInventory = async (
  path: string,
  directory: boolean,
  expectedMetadata: Stats,
  options: Pick<
    ArtifactInventoryOptions,
    | "resourceScope"
    | "signal"
    | "asarHeaderAdmission"
    | "selectedPath"
    | "expectedRootSha256"
    | "espFlashSelection"
    | "readerLimits"
  >,
  probeFacts?: ArtifactEmbeddedFormatProbeFacts,
): Promise<RootInventoryClassification> => {
  if (directory && probeFacts !== undefined) {
    abortIfNeeded(options.signal);
    throw new ArtifactReaderFailure(
      "integrity",
      `Root artifact changed before inventory: ${path}`,
      { integrityCheck: "container-identity" },
    );
  }
  if (directory && options.expectedRootSha256 !== undefined)
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact root changed after target admission: expected an admitted file at ${path}, observed a directory`,
      {
        integrityCheck: "container-identity",
        userMessage:
          "The opened file was replaced by a directory. Select the intended artifact and reopen it before retrying.",
      },
    );
  if (directory)
    return {
      format: "directory",
      digest: null,
      rootSource: undefined,
      readerAdmission: undefined,
    };
  if (options.expectedRootSha256 !== undefined)
    await assertArtifactSelectedSource(path, options.selectedPath);
  const source = await openRootArtifact(
    path,
    options.resourceScope,
    options.signal,
  );
  const { handle, initial } = source;
  let outcome:
    | {
        readonly kind: "completed";
        readonly value: RootInventoryClassification;
      }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    if (!sameRegularFileState(expectedMetadata, initial))
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed before inventory: ${path}`,
        { integrityCheck: "container-identity" },
      );
    // Prior probe state can prove replacement without interpreting any bytes.
    const probes = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      options.signal,
      probeFacts,
      options.readerLimits,
    );
    const admittedDigest =
      options.expectedRootSha256 === undefined
        ? undefined
        : await classifyStableRootArtifactHandle(
            path,
            handle,
            initial,
            options.signal,
          );
    if (admittedDigest !== undefined)
      assertAdmittedRootDigest(
        path,
        options.expectedRootSha256,
        admittedDigest.sha256,
      );
    const classified = await classifyRootFormat(
      path,
      source,
      probes,
      options.signal,
      options.asarHeaderAdmission,
      options.selectedPath,
      options.espFlashSelection,
      options.readerLimits,
    );
    const format =
      typeof classified === "string" ? classified : classified.kind;
    const digest =
      admittedDigest ??
      (await classifyStableRootArtifactHandle(
        path,
        handle,
        initial,
        options.signal,
      ));
    const retainSource =
      artifactFormatDescriptor(format)?.retainClassifiedSource === true;
    const recognitionLimitations = probes.recognitionLimitations();
    outcome = {
      kind: "completed",
      value: {
        format,
        digest,
        ...(recognitionLimitations.length === 0
          ? {}
          : { recognitionLimitations }),
        rootSource: retainSource ? source : undefined,
        readerAdmission:
          typeof classified !== "string"
            ? classified
            : retainSource
              ? source
              : undefined,
      },
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (outcome.kind === "failed" || outcome.value.rootSource === undefined) {
    await releaseRootArtifact(
      path,
      source.owner,
      options.resourceScope,
      outcome.kind === "completed"
        ? { kind: "completed", digest: outcome.value.digest }
        : outcome,
      options.signal,
    );
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

type DenoPresentProbe = Extract<
  Awaited<ReturnType<ArtifactEmbeddedFormatProbes["denoStandalone"]>>,
  { readonly status: "present" }
>;

export type EmbeddedExecutablePackage =
  | { readonly format: "deno-standalone"; readonly probe: DenoPresentProbe }
  | { readonly format: "node-sea"; readonly location: NodeSeaLocation }
  | {
      readonly format: "bun-standalone";
      readonly probe: Extract<
        BunStandaloneProbe,
        { readonly status: "present" }
      >;
    }
  | { readonly format: "dotnet-bundle"; readonly headerOffset: number }
  | { readonly format: "pyinstaller"; readonly cookie: PyInstallerCookie };

export type EmbeddedExecutablePackageProbe =
  | {
      readonly status: "present";
      readonly package: EmbeddedExecutablePackage;
    }
  | { readonly status: "absent" }
  | {
      readonly status: "unknown";
      readonly limitations: readonly string[];
    };

/**
 * Executable-branch package order for a native image.
 * Root classification and release-exposure probing both use this decision.
 */
export const classifyEmbeddedExecutablePackage = async (
  probes: ArtifactEmbeddedFormatProbes,
  nativeFormat: string,
  signal?: AbortSignal,
): Promise<EmbeddedExecutablePackageProbe> => {
  const sea = await probes.nodeSea();
  abortIfNeeded(signal);
  if (sea !== undefined)
    return {
      status: "present",
      package: { format: "node-sea", location: sea },
    };
  const bun = await probes.bunStandalone();
  if (bun.status === "present")
    return {
      status: "present",
      package: { format: "bun-standalone", probe: bun },
    };
  const deno = await probes.denoStandalone();
  if (deno.status === "present")
    return {
      status: "present",
      package: { format: "deno-standalone", probe: deno },
    };
  const packaged = await probes.pyInstaller();
  abortIfNeeded(signal);
  if (nativeFormat !== "mach-o-universal") {
    const headerOffset = await probes.dotnetBundle();
    if (headerOffset !== undefined)
      return {
        status: "present",
        package: { format: "dotnet-bundle", headerOffset },
      };
  }
  if (packaged !== undefined)
    return {
      status: "present",
      package: { format: "pyinstaller", cookie: packaged },
    };
  const limitations = probes.recognitionLimitations();
  if (limitations.length > 0) return { status: "unknown", limitations };
  return { status: "absent" };
};

const classifyRootFormat = async (
  path: string,
  source: RootInventorySource,
  embeddedProbes: ArtifactEmbeddedFormatProbes,
  signal?: AbortSignal,
  asarHeaderAdmission?: AsarHeaderAdmission,
  selectedPath?: string,
  espFlashSelection?: EspFlashSelection,
  readerLimits: ArtifactReaderLimits = resolveArtifactReaderLimits(),
): Promise<ArtifactOccurrence["artifact_format"] | ArtifactFormatAdmission> => {
  const { handle } = source;
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
  try {
    await assertStableRegularFileIdentity(handle, path, source.initial, {
      symlinks: "reject",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileChangedError)
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed during classification: ${path}`,
        { cause: cause.cause ?? cause, integrityCheck: "container-identity" },
      );
    throw artifactOperationCause(cause);
  }
  // Fill each range: a short result is end of file, not a partial host read.
  const read = createCachedPrefixReader(
    handle,
    evidence.prefix,
    archiveBytes,
    () => abortIfNeeded(signal),
  );
  const locateFlash = (selection: EspFlashSelection, explicit: boolean) =>
    locateEspFlashLayout(archiveBytes, read, selection, {
      explicit,
      ...(signal === undefined ? {} : { signal }),
    });
  // The caller's format selection decides before any other signature.
  if (espFlashSelection !== undefined) {
    const selected = await locateFlash(espFlashSelection, true);
    if (!selected.ok)
      throw new ArtifactReaderFailure(
        "unavailable",
        `ESP flash image layout is not recognized: ${selected.error}`,
      );
    return { kind: "esp-flash-image", source, location: selected.value };
  }
  if (nesContainerFormat(evidence.prefix) !== undefined) return "ines";
  const classificationPath = artifactNameForClassification(
    selectedPath ?? path,
    path,
  );
  const lower = classificationPath.toLowerCase();
  if (hasZipSignature(evidence.prefix)) return zipRootPackageFormat(lower);
  if (lower.endsWith(".pkg") && hasXarMagic(evidence.prefix)) return "pkg";
  if (
    lower.endsWith(".dmg") &&
    (await hasDiskImageSignature(archiveBytes, read))
  )
    return "dmg";
  if (
    await probeUefiFlashImage(handle, signal, {
      fileSize: archiveBytes,
      prefix: evidence.prefix,
    })
  )
    return "uefi";
  const pck = await embeddedProbes.godotPck(evidence.prefix);
  if (pck !== undefined) return { kind: "godot-pck", source, location: pck };
  // A C3 or S3 dump begins with its bootloader, so the layout is located
  // before the bytes are read as one ESP image.
  const flash = await locateFlash({}, false);
  if (flash.ok)
    return { kind: "esp-flash-image", source, location: flash.value };
  const fatEvidence = await readRootFatSliceHeaders(handle, evidence, signal);
  const mzWindowsHeaderRecord = await readRootMzWindowsHeaderRecord(
    handle,
    fatEvidence,
    archiveBytes,
    signal,
  );
  const mzWindowsHeaderSignature =
    mzWindowsHeaderRecord === undefined
      ? fatEvidence.mzWindowsHeaderSignature
      : {
          offset: mzWindowsHeaderRecord.offset,
          bytes: mzWindowsHeaderRecord.bytes.subarray(0, 4),
        };
  // The probe stops at its bounded prefix, so a DfuSe trailer is read from
  // the file's own end unless the probe already observed every byte.
  const suffix =
    fatEvidence.suffix === undefined &&
    archiveBytes >= DFUSE_SUFFIX_BYTES &&
    hasDfuSePrefix(evidence.prefix)
      ? await read(archiveBytes - DFUSE_SUFFIX_BYTES, DFUSE_SUFFIX_BYTES)
      : fatEvidence.suffix;
  // Likewise the ISO 9660 descriptor signature lies past the bounded prefix.
  const iso9660Descriptor =
    fatEvidence.iso9660Descriptor === undefined &&
    archiveBytes >= ISO9660_RECOGNITION_BYTES
      ? await read(ISO9660_DESCRIPTOR_OFFSET, ISO9660_SIGNATURE_BYTES)
      : fatEvidence.iso9660Descriptor;
  const classificationEvidence = {
    ...fatEvidence,
    ...(suffix === undefined ? {} : { suffix }),
    ...(iso9660Descriptor === undefined ? {} : { iso9660Descriptor }),
    ...(mzWindowsHeaderSignature === undefined
      ? {}
      : { mzWindowsHeaderSignature }),
    ...(mzWindowsHeaderRecord === undefined ? {} : { mzWindowsHeaderRecord }),
  };
  const format = classifyArtifactContent(
    classificationPath,
    classificationEvidence,
    archiveBytes,
  ).format;
  // Only bytes no other format claims may lead a located ZIP, so an
  // executable with an appended archive keeps its executable classification.
  if (
    (format === "file" || format === "unknown") &&
    !claimsExecutableHeader(evidence.prefix, archiveBytes) &&
    (await hasTrailingZipArchive(archiveBytes, read))
  )
    return zipRootPackageFormat(lower);
  if (["elf", "pe", "mach-o", "mach-o-universal"].includes(format)) {
    const embeddedProbe = await classifyEmbeddedExecutablePackage(
      embeddedProbes,
      format,
      signal,
    );
    const embedded =
      embeddedProbe.status === "present" ? embeddedProbe.package : undefined;
    if (embedded?.format === "node-sea") {
      try {
        const decoded = await decodeNodeSeaBlob(
          await readNodeSeaBlob(
            source,
            embedded.location,
            signal,
            readerLimits.node_sea,
          ),
          signal,
          readerLimits.node_sea,
        );
        return {
          kind: "node-sea",
          source,
          location: embedded.location,
          decoded,
          limits: readerLimits.node_sea,
        };
      } catch (cause: unknown) {
        if (
          cause instanceof ArtifactReaderFailure &&
          (cause.reason === "format" ||
            (cause.reason === "limit" &&
              (cause.readerLimit?.parameter ===
                "artifact_limits.node_sea.blob_bytes" ||
                cause.readerLimit === undefined)))
        ) {
          abortIfNeeded(signal);
          embeddedProbes.recordNodeSeaRecognitionFailure(cause);
          return format;
        }
        throw cause;
      }
    }
    if (embedded?.format === "bun-standalone")
      return { kind: "bun-standalone", source, probe: embedded.probe };
    if (embedded?.format === "deno-standalone")
      return { kind: "deno-standalone", source, probe: embedded.probe };
    if (embedded?.format === "dotnet-bundle")
      return {
        kind: "dotnet-bundle",
        source,
        headerOffset: embedded.headerOffset,
      };
    // A valid cookie also proves enough bytes for a thin Mach-O identity;
    // PE and universal Mach-O classification already require stronger proof.
    if (embedded?.format === "pyinstaller")
      return {
        kind: "pyinstaller",
        source,
        cookie: embedded.cookie,
        carrierPathDialect: format === "pe" ? "windows" : "posix",
      };
  }
  if (
    format === "asar" &&
    evidence.asarHeader.state === "matched" &&
    evidence.asarHeader.extents.archiveBytes === archiveBytes
  ) {
    return {
      kind: "asar",
      source,
      extents: {
        archiveBytes,
        headerBytes: evidence.asarHeader.extents.headerBytes,
        jsonBytes: evidence.asarHeader.extents.jsonBytes,
      },
      headerAdmission: evidence.asarHeader.admission,
    };
  }
  return format;
};

/** Read exact FAT header windows missed by the bounded prefix probe. */
const readRootFatSliceHeaders = async (
  handle: FileHandle,
  evidence: ArtifactClassificationEvidence,
  signal?: AbortSignal,
): Promise<ArtifactClassificationEvidence> => {
  const { fatHeader } = evidence;
  if (fatHeader.state !== "parsed") return evidence;
  const { sliceHeadersByOffset } = await readFatSliceHeaders(
    fatHeader,
    async (offset, length) => {
      const thinHeader = await readFileHandleRange(handle, offset, length, () =>
        abortIfNeeded(signal),
      );
      abortIfNeeded(signal);
      return thinHeader;
    },
    { existing: evidence.fatSliceHeadersByOffset, minSliceSize: 4 },
  );
  return { ...evidence, fatSliceHeadersByOffset: sliceHeadersByOffset };
};

/** Read the missing PE record bytes requested by bounded MZ classification. */
const readRootMzWindowsHeaderRecord = async (
  handle: FileHandle,
  evidence: ArtifactClassificationEvidence,
  fileSize: number,
  signal?: AbortSignal,
): Promise<MzWindowsHeaderRecordEvidence | undefined> => {
  const observation = observeMzWindowsHeader(evidence.prefix, fileSize);
  if (
    observation.state !== "signature-needed" &&
    !(observation.state === "declared" && observation.signature === "PE")
  )
    return evidence.mzWindowsHeaderRecord;
  const { offset } = observation;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= fileSize)
    return evidence.mzWindowsHeaderRecord;

  const window = Buffer.alloc(
    PE_RECORD_HEADER_BYTES + MAX_PE_OPTIONAL_HEADER_BYTES,
  );
  const existing =
    evidence.mzWindowsHeaderRecord?.offset === offset
      ? evidence.mzWindowsHeaderRecord.bytes
      : undefined;
  const inline =
    offset < evidence.prefix.length
      ? evidence.prefix.subarray(
          offset,
          Math.min(
            offset + PE_RECORD_HEADER_BYTES + MAX_PE_OPTIONAL_HEADER_BYTES,
            evidence.prefix.length,
          ),
        )
      : undefined;
  const known =
    existing !== undefined &&
    (inline === undefined || existing.length > inline.length)
      ? existing
      : inline;
  known?.copy(window);
  let available = known?.length ?? 0;
  const requiredLength = (): number => {
    if (available < 2 || window[0] !== 0x50 || window[1] !== 0x45) return 2;
    if (available < 4 || window[2] !== 0 || window[3] !== 0) return 4;
    if (available < PE_RECORD_HEADER_BYTES) return PE_RECORD_HEADER_BYTES;
    const optionalHeaderSize = new BinaryReader(window, true, "pe").u16(20);
    return Math.min(
      PE_RECORD_HEADER_BYTES + optionalHeaderSize,
      PE_RECORD_HEADER_BYTES + MAX_PE_OPTIONAL_HEADER_BYTES,
    );
  };
  while (available < requiredLength() && offset + available < fileSize) {
    abortIfNeeded(signal);
    const length = Math.min(
      requiredLength() - available,
      fileSize - offset - available,
    );
    const chunk = await readFileHandleRange(
      handle,
      offset + available,
      length,
      () => abortIfNeeded(signal),
      window.subarray(available, available + length),
    );
    abortIfNeeded(signal);
    if (chunk.length === 0) break;
    available += chunk.length;
  }
  if (available === 0) return undefined;
  return { offset, bytes: window.subarray(0, available) };
};

/** Compare physically completed bytes before interpreting an admitted file root. */
export const assertAdmittedRootDigest = (
  path: string,
  expected: string | undefined,
  observed: string,
): void => {
  if (expected !== undefined && observed !== expected)
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact root changed after target admission at ${path}: expected ${expected}, observed ${observed}`,
      {
        integrityCheck: "container-identity",
        userMessage:
          "The artifact changed after it was opened. Reopen the selected artifact, then retry.",
      },
    );
};

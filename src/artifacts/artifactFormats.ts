import type { AsarHeaderAdmission } from "../config/asarHeaderAdmission.js";
import type { ArtifactIntegrityPolicyName } from "../domain/artifactIntegrityPolicy.js";
import {
  ARTIFACT_FORMAT_IDS,
  type ArtifactFormatId,
} from "../domain/artifactGraph.js";
import type { EspFlashSelection } from "../domain/firmware/espFlashLocation.js";
import { ANDROID_OTA_PAYLOAD_LIMITATIONS } from "../domain/firmware/androidOtaPayload.js";
import { ESP_IMAGE_LIMITATIONS } from "../domain/firmware/espImageFacts.js";
import {
  ZIP_PACKAGE_FORMATS,
  type ZipPackageFormat,
} from "../domain/zipPackageFormat.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
  DirectoryArtifactReader,
  ZipArtifactReader,
} from "../resources/index.js";
import type { ArtifactReaderAdmission } from "./ArtifactReaderAdmission.js";
import { AndroidBootImageArtifactReader } from "./AndroidBootImageArtifactReader.js";
import { AsarArtifactReader } from "./AsarArtifactReader.js";
import type { BunStandaloneAdmission } from "./bun/BunStandaloneAdmission.js";
import { BunStandaloneArtifactReader } from "./BunStandaloneArtifactReader.js";
import type { DenoStandaloneAdmission } from "./deno/DenoStandaloneAdmission.js";
import { DenoStandaloneArtifactReader } from "./DenoStandaloneArtifactReader.js";
import { DfuSeArtifactReader } from "./DfuSeArtifactReader.js";
import type { DotnetBundleAdmission } from "./dotnet/DotnetBundleAdmission.js";
import { DotnetBundleArtifactReader } from "./DotnetBundleArtifactReader.js";
import {
  EspFlashImageArtifactReader,
  type EspFlashAdmission,
} from "./EspFlashImageArtifactReader.js";
import { EspImageArtifactReader } from "./EspImageArtifactReader.js";
import { FitArtifactReader } from "./FitArtifactReader.js";
import type { GodotPckAdmission } from "./GodotPckLocation.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";
import { InesArtifactReader } from "./InesArtifactReader.js";
import { HexRecordArtifactReader } from "./HexRecordArtifactReader.js";
import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "./NativeDmgArtifactReader.js";
import type { NodeSeaAdmission } from "./nodeSea/NodeSeaAdmission.js";
import { NodeSeaArtifactReader } from "./NodeSeaArtifactReader.js";
import type { PyInstallerAdmission } from "./pyinstaller/PyInstallerAdmission.js";
import { PyInstallerArtifactReader } from "./PyInstallerArtifactReader.js";
import { UefiArtifactReader } from "../uefi/UefiArtifactReader.js";
import { Uf2ArtifactReader } from "./Uf2ArtifactReader.js";
import { NtfsMftArtifactReader } from "./NtfsMftArtifactReader.js";
import { AuditdLogArtifactReader } from "./AuditdLogArtifactReader.js";
import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import { UImageArtifactReader } from "./UImageArtifactReader.js";
import { UnityFsArtifactReader } from "./UnityFsArtifactReader.js";
import { WxapkgArtifactReader } from "./WxapkgArtifactReader.js";

/** How inventory describes a format when no reader was constructed. */
export type AbsentInventory = "platform" | "universal" | "unavailable" | "root";

export interface ArtifactReaderConstruction {
  readonly readerLimits?:
    | import("../domain/artifactReaderLimits.js").ArtifactReaderLimits
    | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly unreadableDirectories: "fail" | "omit";
  readonly admission?: ArtifactReaderAdmission | undefined;
  readonly asarHeaderAdmission?: AsarHeaderAdmission | undefined;
  /** Caller inputs for an explicitly selected ESP flash image. */
  readonly espFlashSelection?: EspFlashSelection | undefined;
  /** Caller-selected root spelling; only ASAR companion lookup consumes this. */
  readonly selectedPath?: string | undefined;
  /**
   * Caller choice for a contradiction between a reader's independent witness
   * and the container's own bytes; universal Mach-O lipo records consume it.
   */
  readonly integrity?: ArtifactIntegrityPolicyName | undefined;
}

export interface FormatDescriptor {
  readonly id: ArtifactFormatId;
  /** Root occurrence kind is container, including directories and zip packages. */
  readonly occurrenceContainer: boolean;
  /** Path-role classification treats the format as a container of its own. */
  readonly roleContainer: boolean;
  /** Classification keeps the admitted source for a later reader. */
  readonly retainClassifiedSource: boolean;
  /** Extraction can open this format without an embedded-pack probe. */
  readonly extractable: boolean;
  /** Reader construction is refused off macOS. */
  readonly requiresDarwin: boolean;
  readonly absentInventory: AbsentInventory;
  /** Extra limitation when a reader was constructed. */
  readonly readerLimitation?: string;
  /** Absent for formats with no entry reader, including `unknown`. */
  readonly createReader?:
    | ((path: string, options: ArtifactReaderConstruction) => ArtifactReader)
    | undefined;
}

const sourceOf = (options: ArtifactReaderConstruction) => {
  const admission = options.admission;
  return admission !== undefined && "kind" in admission
    ? admission.source
    : admission;
};

function admittedAs(
  kind: "dotnet-bundle",
  options: ArtifactReaderConstruction,
): DotnetBundleAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "bun-standalone",
  options: ArtifactReaderConstruction,
): BunStandaloneAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "deno-standalone",
  options: ArtifactReaderConstruction,
): DenoStandaloneAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "godot-pck",
  options: ArtifactReaderConstruction,
): GodotPckAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "pyinstaller",
  options: ArtifactReaderConstruction,
): PyInstallerAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "node-sea",
  options: ArtifactReaderConstruction,
): NodeSeaAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: "esp-flash-image",
  options: ArtifactReaderConstruction,
): EspFlashAdmission | ReturnType<typeof sourceOf>;
function admittedAs(
  kind: string,
  options: ArtifactReaderConstruction,
): ArtifactReaderAdmission | ReturnType<typeof sourceOf> {
  const admission = options.admission;
  return admission !== undefined &&
    "kind" in admission &&
    admission.kind === kind
    ? admission
    : sourceOf(options);
}

/** One capability row for every ZIP-backed package family. */
const ZIP_FAMILY_CAPABILITIES = {
  occurrenceContainer: true,
  roleContainer: false,
  retainClassifiedSource: true,
  extractable: true,
  requiresDarwin: false,
  absentInventory: "unavailable",
} as const satisfies Omit<FormatDescriptor, "id" | "createReader">;

type FormatCapabilities = Omit<FormatDescriptor, "id" | "createReader">;
type ReaderFn = (
  path: string,
  options: ArtifactReaderConstruction,
) => ArtifactReader;

const withReader = <Id extends ArtifactFormatId>(
  id: Id,
  capabilities: FormatCapabilities,
  createReader: ReaderFn,
) => ({ id, ...capabilities, createReader });

const withoutReader = <Id extends ArtifactFormatId>(
  id: Id,
  capabilities: FormatCapabilities,
) => ({ id, ...capabilities });

const zipDescriptor = (id: ZipPackageFormat) =>
  withReader(
    id,
    ZIP_FAMILY_CAPABILITIES,
    (path, options) =>
      new ZipArtifactReader(
        path,
        id,
        undefined,
        sourceOf(options),
        options.readerLimits?.expanded_bytes,
      ),
  );

function described<Id extends ArtifactFormatId>(
  id: Id,
  descriptor: FormatCapabilities & { readonly createReader: ReaderFn },
): ReturnType<typeof withReader<Id>>;
function described<Id extends ArtifactFormatId>(
  id: Id,
  descriptor: FormatCapabilities,
): ReturnType<typeof withoutReader<Id>>;
function described<Id extends ArtifactFormatId>(
  id: Id,
  descriptor: FormatCapabilities & { readonly createReader?: ReaderFn },
) {
  const { createReader, ...capabilities } = descriptor;
  return createReader === undefined
    ? withoutReader(id, capabilities)
    : withReader(id, capabilities, createReader);
}

const plain = {
  occurrenceContainer: false,
  roleContainer: false,
  retainClassifiedSource: false,
  extractable: false,
  requiresDarwin: false,
  absentInventory: "root",
} as const satisfies Omit<FormatDescriptor, "id" | "createReader">;

function container<Id extends ArtifactFormatId>(
  id: Id,
  descriptor: Partial<FormatCapabilities> & { readonly createReader: ReaderFn },
): ReturnType<typeof withReader<Id>>;
function container<Id extends ArtifactFormatId>(
  id: Id,
  descriptor?: Partial<FormatCapabilities>,
): ReturnType<typeof withoutReader<Id>>;
function container<Id extends ArtifactFormatId>(
  id: Id,
  descriptor: Partial<FormatCapabilities> & {
    readonly createReader?: ReaderFn;
  } = {},
) {
  const { createReader, ...rest } = descriptor;
  const capabilities = {
    ...plain,
    occurrenceContainer: true as const,
    ...rest,
  };
  return createReader === undefined
    ? withoutReader(id, capabilities)
    : withReader(id, capabilities, createReader);
}

const NON_ZIP_FORMATS = {
  "dotnet-bundle": container("dotnet-bundle", {
    retainClassifiedSource: true,
    absentInventory: "root",
    createReader: (path, options) =>
      new DotnetBundleArtifactReader(
        path,
        admittedAs("dotnet-bundle", options),
        options.readerLimits?.dotnet_bundle,
      ),
  }),
  "bun-standalone": container("bun-standalone", {
    retainClassifiedSource: true,
    absentInventory: "unavailable",
    createReader: (path, options) =>
      new BunStandaloneArtifactReader(
        path,
        admittedAs("bun-standalone", options),
        options.readerLimits?.bun,
        options.readerLimits?.expanded_bytes,
      ),
  }),
  "deno-standalone": container("deno-standalone", {
    retainClassifiedSource: true,
    absentInventory: "unavailable",
    readerLimitation:
      "Deno compile inventory reports the embedded virtual filesystem, remote modules, and recorded options. Environment-file values and CA certificate bytes are retained in local Evidence with their counts and byte lengths. The npm snapshot is not decoded, and the executable is not run.",
    createReader: (path, options) =>
      new DenoStandaloneArtifactReader(
        path,
        admittedAs("deno-standalone", options),
      ),
  }),
  dmg: container("dmg", {
    requiresDarwin: true,
    absentInventory: "platform",
    createReader: (path, options) =>
      new NativeDmgArtifactReader(path, options.environment),
  }),
  pkg: container("pkg", { absentInventory: "platform" }),
  asar: container("asar", {
    extractable: true,
    absentInventory: "unavailable",
    createReader: (path, options) =>
      new AsarArtifactReader(path, {
        ...(options.asarHeaderAdmission === undefined
          ? {}
          : { headerAdmission: options.asarHeaderAdmission }),
        ...(options.selectedPath === undefined
          ? {}
          : { selectedPath: options.selectedPath }),
      }),
  }),
  ines: container("ines", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    createReader: (path, options) => {
      const source = sourceOf(options);
      if (source === undefined)
        throw new ArtifactReaderFailure(
          "integrity",
          "iNES inventory requires its admitted source descriptor",
          { integrityCheck: "inventory-node" },
        );
      return new InesArtifactReader(path, source);
    },
  }),
  "godot-pck": container("godot-pck", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "PCK inventory establishes packaged bytes and metadata; scenes, binary resources, GDScript bytecode and runtime signal behavior were not decoded.",
    createReader: (path, options) =>
      new GodotPckArtifactReader(
        path,
        admittedAs("godot-pck", options),
        options.readerLimits?.godot,
        options.readerLimits?.expanded_bytes,
      ),
  }),
  unityfs: container("unityfs", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "UnityFS inventory establishes packaged bytes and metadata; serialized objects, textures, meshes and runtime asset behavior were not decoded. LZMA-compressed members are unsupported.",
    createReader: (path, options) =>
      new UnityFsArtifactReader(path, sourceOf(options)),
  }),
  wxapkg: container("wxapkg", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "wxapkg inventory establishes packaged member names and stored bytes; wxml/wxss sources, compiled bundles and runtime behavior are not reconstructed. V1MMWX-encrypted packages are unsupported.",
    createReader: (path, options) =>
      new WxapkgArtifactReader(path, sourceOf(options)),
  }),
  uimage: container("uimage", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "uImage inventory establishes the 64-byte legacy header facts and stored payload bytes. Compressed payloads are not decompressed, and the image is not executed.",
    createReader: (path, options) =>
      new UImageArtifactReader(path, sourceOf(options)),
  }),
  "android-boot-image": container("android-boot-image", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "Android boot image inventory establishes header facts and stored component bytes. Payloads are not decompressed, the v4 signature and AVB footer are not verified, and the image is not executed.",
    createReader: (path, options) =>
      new AndroidBootImageArtifactReader(path, sourceOf(options)),
  }),
  "android-ota-payload": container("android-ota-payload", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation: ANDROID_OTA_PAYLOAD_LIMITATIONS.inventoryScope,
    createReader: (path, options) =>
      new AndroidOtaPayloadArtifactReader(path, sourceOf(options)),
  }),
  "javascript-bundle": described("javascript-bundle", plain),
  "source-map": described("source-map", plain),
  "mach-o-universal": described("mach-o-universal", {
    ...plain,
    retainClassifiedSource: true,
    extractable: true,
    requiresDarwin: true,
    absentInventory: "universal",
    createReader: (path, options) =>
      new MachOSliceArtifactReader(
        path,
        options.environment,
        undefined,
        sourceOf(options),
        options.integrity,
      ),
  }),
  "mach-o": described("mach-o", plain),
  elf: described("elf", plain),
  pe: described("pe", plain),
  "dos-mz": described("dos-mz", plain),
  "dos-com": described("dos-com", plain),
  "raw-binary": described("raw-binary", plain),
  "gamecube-dol": described("gamecube-dol", plain),
  hopper: described("hopper", plain),
  "analysis-database": described("analysis-database", plain),
  uefi: described("uefi", {
    ...plain,
    retainClassifiedSource: true,
    absentInventory: "unavailable",
    createReader: (path, options) =>
      new UefiArtifactReader(path, sourceOf(options)),
  }),
  plist: described("plist", plain),
  entitlements: described("entitlements", plain),
  directory: container("directory", {
    absentInventory: "unavailable",
    createReader: (path, options) =>
      new DirectoryArtifactReader(path, options.unreadableDirectories),
  }),
  file: described("file", plain),
  pyinstaller: container("pyinstaller", {
    retainClassifiedSource: true,
    createReader: (path, options) =>
      new PyInstallerArtifactReader(path, admittedAs("pyinstaller", options)),
  }),
  "node-sea": container("node-sea", {
    retainClassifiedSource: true,
    absentInventory: "unavailable",
    readerLimitation:
      "Node SEA inventory establishes the injected blob, flags, fuse sentinel, main script, optional code cache, snapshot, and assets. V8 snapshots and code cache are not deserialized, and the application is not executed.",
    createReader: (path, options) =>
      new NodeSeaArtifactReader(
        path,
        admittedAs("node-sea", options),
        options.readerLimits?.node_sea,
        options.readerLimits?.expanded_bytes,
      ),
  }),
  "intel-hex": container("intel-hex", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "Intel HEX/S-record inventory decodes data records into address-contiguous regions. It does not establish CPU, byte order, memory map, or that a declared start address is executable; gaps are unwritten, not zero.",
    createReader: (path, options) =>
      new HexRecordArtifactReader(path, "intel-hex", sourceOf(options)),
  }),
  srec: container("srec", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "Intel HEX/S-record inventory decodes data records into address-contiguous regions. It does not establish CPU, byte order, memory map, or that a declared start address is executable; gaps are unwritten, not zero.",
    createReader: (path, options) =>
      new HexRecordArtifactReader(path, "srec", sourceOf(options)),
  }),
  "esp-image": container("esp-image", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation: ESP_IMAGE_LIMITATIONS.inventoryScope,
    createReader: (path, options) =>
      new EspImageArtifactReader(path, sourceOf(options)),
  }),
  uf2: container("uf2", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "UF2 inventory decodes main-flash block payloads into address-contiguous regions per familyID. It does not establish CPU, byte order, memory map, or an entry point; a familyID names a target family, and gaps are unwritten, not zero.",
    createReader: (path, options) =>
      new Uf2ArtifactReader(path, sourceOf(options)),
  }),
  dfuse: container("dfuse", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "DfuSe inventory lists each target element as one region at its declared address. It does not establish CPU, byte order, memory map, or an entry point; an alternate setting selects a device memory, not an address space REA can interpret.",
    createReader: (path, options) =>
      new DfuSeArtifactReader(path, sourceOf(options)),
  }),
  "esp-flash-image": container("esp-flash-image", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "ESP flash layout inventory reads a dump's bootloader region, partition table and partitions and decodes the bootloader and app partitions as ESP images. The OTA selection is derived without app rollback or anti-rollback, and the running partition is unknown. Partitions, nvs_keys included, are extracted as ordinary data; nothing is decrypted.",
    createReader: (path, options) =>
      new EspFlashImageArtifactReader(
        path,
        admittedAs("esp-flash-image", options),
        options.espFlashSelection,
      ),
  }),
  fit: container("fit", {
    roleContainer: true,
    retainClassifiedSource: true,
    extractable: true,
    absentInventory: "unavailable",
    readerLimitation:
      "FIT inventory reports each /images node's stored bytes and its declared type, architecture, OS, compression, load and entry. Image data is not decompressed or decrypted, signatures are not verified, nothing is executed, and load and entry addresses are declarations.",
    createReader: (path, options) =>
      new FitArtifactReader(path, sourceOf(options)),
  }),
  "ntfs-mft": described("ntfs-mft", {
    ...plain,
    retainClassifiedSource: true,
    readerLimitation:
      "MFT inventory reports whole-stream counts and up to 32 physical FILE record details, including fixup coverage, supported names, timestamps, declared sizes and attributes. Bounded attribute-list links expose verified metadata from acquired extension records, with explicit reference outcomes and omissions. Nonresident list values and file contents are not recovered; full paths and complete change history are not established. Use inspect_ntfs_journal for caller-paired journal events.",
    createReader: (path, options) =>
      new NtfsMftArtifactReader(path, sourceOf(options)),
  }),
  "auditd-log": described("auditd-log", {
    ...plain,
    retainClassifiedSource: true,
    readerLimitation:
      "auditd log inventory reports record and event totals, per-type counts and a bounded window of events joined on their full audit event identity (node, timestamp and serial), with duplicate, out-of-order and malformed records counted. Per-record identity is retained for a bounded window of recent events; events and records past it are counted in the totals but their duplicate and interleaving status is not established. Record key-value fields, hex and escaped values, argument ordering and decoded syscall or permission meanings are not interpreted; the log is not treated as complete or authentic.",
    createReader: (path, options) =>
      new AuditdLogArtifactReader(path, sourceOf(options)),
  }),
  unknown: described("unknown", plain),
} satisfies Record<
  Exclude<ArtifactFormatId, ZipPackageFormat>,
  FormatDescriptor
>;

const ZIP_FORMATS = Object.fromEntries(
  ZIP_PACKAGE_FORMATS.map((id) => [id, zipDescriptor(id)]),
) as {
  readonly [Id in ZipPackageFormat]: ReturnType<typeof zipDescriptor>;
};

/**
 * One descriptor per domain format id. `unknown` has no reader. ZIP package
 * families share {@link ZIP_FAMILY_CAPABILITIES}.
 */
const ARTIFACT_FORMAT_REGISTRY = {
  ...NON_ZIP_FORMATS,
  ...ZIP_FORMATS,
};

export const ARTIFACT_FORMATS: {
  readonly [Id in ArtifactFormatId]: (typeof ARTIFACT_FORMAT_REGISTRY)[Id];
} = ARTIFACT_FORMAT_REGISTRY;

const listedFormatIds: readonly ArtifactFormatId[] = ARTIFACT_FORMAT_IDS;

/** Descriptor for a recognized format id, when the value is one. */
export const artifactFormatDescriptor = (
  format: string,
): FormatDescriptor | undefined =>
  listedFormatIds.some((id) => id === format)
    ? ARTIFACT_FORMATS[format as ArtifactFormatId]
    : undefined;

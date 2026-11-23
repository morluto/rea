import { z } from "zod";
import {
  bunStandaloneEntryMetadataSchema,
  bunStandaloneMetadataSchema,
  denoStandaloneEntryMetadataSchema,
  denoStandaloneMetadataSchema,
  dotnetBundleEntryMetadataSchema,
  godotPckEntryMetadataSchema,
  godotPckMetadataSchema,
  nodeSeaEntryMetadataSchema,
  nodeSeaMetadataSchema,
  pyInstallerEntryMetadataSchema,
  pyInstallerMetadataSchema,
  unityFsEntryMetadataSchema,
  unityFsMetadataSchema,
  wxapkgEntryMetadataSchema,
  wxapkgMetadataSchema,
} from "./formatMetadata/packageAndGameMetadata.js";
import {
  dfuSeElementMetadataSchema,
  dfuSeMetadataSchema,
  espFlashImageMetadataSchema,
  espFlashPartitionMetadataSchema,
  espImageMetadataSchema,
  espImageSegmentMetadataSchema,
  espImageSignatureBlockMetadataSchema,
  fitImageMetadataSchema,
  fitMetadataSchema,
  hexRecordRegionMetadataSchema,
  hexRecordsMetadataSchema,
  uf2MetadataSchema,
  uf2RegionMetadataSchema,
  uImageEntryMetadataSchema,
  uImageMetadataSchema,
} from "./formatMetadata/firmwareMetadata.js";
import {
  androidBootImageEntryMetadataSchema,
  androidBootImageMetadataSchema,
  androidOtaPartitionMetadataSchema,
  androidOtaPayloadMetadataSchema,
  axmlDocumentMetadataSchema,
  axmlMetadataSchema,
  ntfsMftMetadataSchema,
} from "./formatMetadata/androidAndSystemMetadata.js";

export const artifactFormatMetadataSchema = z.discriminatedUnion("kind", [
  godotPckMetadataSchema,
  godotPckEntryMetadataSchema,
  unityFsMetadataSchema,
  unityFsEntryMetadataSchema,
  wxapkgMetadataSchema,
  wxapkgEntryMetadataSchema,
  pyInstallerMetadataSchema,
  pyInstallerEntryMetadataSchema,
  dotnetBundleEntryMetadataSchema,
  bunStandaloneMetadataSchema,
  bunStandaloneEntryMetadataSchema,
  denoStandaloneMetadataSchema,
  denoStandaloneEntryMetadataSchema,
  nodeSeaMetadataSchema,
  nodeSeaEntryMetadataSchema,
  hexRecordsMetadataSchema,
  hexRecordRegionMetadataSchema,
  axmlMetadataSchema,
  axmlDocumentMetadataSchema,
  uImageMetadataSchema,
  uImageEntryMetadataSchema,
  androidOtaPayloadMetadataSchema,
  androidOtaPartitionMetadataSchema,
  espImageMetadataSchema,
  espImageSegmentMetadataSchema,
  espImageSignatureBlockMetadataSchema,
  uf2MetadataSchema,
  uf2RegionMetadataSchema,
  ntfsMftMetadataSchema,
  dfuSeMetadataSchema,
  dfuSeElementMetadataSchema,
  espFlashImageMetadataSchema,
  espFlashPartitionMetadataSchema,
  fitMetadataSchema,
  fitImageMetadataSchema,
  androidBootImageMetadataSchema,
  androidBootImageEntryMetadataSchema,
]);
export type ArtifactFormatMetadata = z.infer<
  typeof artifactFormatMetadataSchema
>;

type FormatMetadataByKind = {
  readonly [Metadata in ArtifactFormatMetadata as Metadata["kind"]]: Metadata;
};
type FormatMetadataKind = keyof FormatMetadataByKind;

/**
 * What each kind declares beyond its own bytes, which artifact comparison
 * compares, or why comparison uses none of its facts. Every kind needs an
 * entry, so a new kind does not compile without this decision; a new field
 * of an existing kind still needs a review of its projection. For a node-less
 * metadata record, the projection is all of its format metadata that
 * comparison checks.
 */
const declarationsByKind: {
  readonly [Kind in FormatMetadataKind]:
    | {
        readonly declaration: (
          metadata: FormatMetadataByKind[Kind],
        ) => FormatMetadataDeclaration["facts"];
        /** Projected fields the producer could not interpret. */
        readonly unreadable?: (
          metadata: FormatMetadataByKind[Kind],
        ) => FormatMetadataDeclaration["unreadable"];
      }
    | { readonly notCompared: string };
} = {
  "godot-pck": {
    notCompared:
      "Its fields come from the pack's own bytes, which content comparison covers.",
  },
  "godot-pck-entry": {
    notCompared:
      "index and declared_offset are layout; flags and md5_status repeat occurrence facts; source_path spells Godot's lookup path in a version-dependent way. docs/godot-pck.md gives the evidence.",
  },
  unityfs: {
    notCompared:
      "Its fields come from the bundle's own bytes, which content comparison covers.",
  },
  /** What the directory declares for a member: its source path and raw node flags. Index and offset are layout. */
  "unityfs-entry": {
    declaration: (metadata) => ({
      source_path: metadata.source_path,
      flags: metadata.flags,
    }),
  },
  wxapkg: {
    notCompared:
      "Its fields come from the package's own bytes, which content comparison covers.",
  },
  "wxapkg-entry": {
    notCompared:
      "index is layout. source_path keeps the declared name, including a producer root prefix the occurrence path strips.",
  },
  axml: {
    notCompared:
      "Its fields come from the document's own chunk stream, which content comparison covers.",
  },
  "axml-document": {
    notCompared:
      "The counts describe the decoded document, and length follows from them; the region's bytes are compared by content.",
  },
  pyinstaller: {
    notCompared:
      "Its fields come from the archive's own bytes, which content comparison covers.",
  },
  /** Declaration identity that is stable across archive layout changes. */
  "pyinstaller-entry": {
    declaration: (metadata) => ({
      container: metadata.container,
      container_name: metadata.container_name,
      source_name: metadata.source_name,
      type_code: metadata.type_code,
    }),
  },
  "dotnet-bundle-entry": {
    notCompared:
      "Its fields come from the host's bundle manifest, whose bytes the host's content comparison covers.",
  },
  "bun-standalone": {
    notCompared:
      "Its fields come from the carrier's own bytes, which content comparison covers.",
  },
  "bun-standalone-entry": {
    notCompared:
      "Its fields come from the carrier's module graph, whose bytes the carrier's content comparison covers.",
  },
  "deno-standalone": {
    notCompared:
      "Its fields come from the carrier's own bytes, which content comparison covers.",
  },
  "deno-standalone-entry": {
    notCompared:
      "Its fields come from the carrier's Deno section, whose bytes the carrier's content comparison covers.",
  },
  "node-sea": {
    notCompared:
      "Its fields come from the carrier's own bytes, which content comparison covers.",
  },
  /** Runtime member identity, independent of blob layout and directory order. */
  "node-sea-entry": {
    declaration: (metadata) => ({
      role: metadata.role,
      source_path: metadata.source_path,
    }),
  },
  "hex-records": {
    notCompared:
      "Its fields come from the file's own records, which content comparison covers.",
  },
  "hex-record-region": {
    notCompared:
      "start_address and end_address restate the region's path, and length follows from them; record and line counts are layout.",
  },
  uimage: {
    notCompared:
      "Its header facts come from the image's own bytes, which content comparison covers.",
  },
  "uimage-entry": {
    notCompared:
      "role and index restate the entry's path; its stored bytes are compared by content.",
  },
  "android-boot-image": {
    notCompared:
      "Its header facts come from the image's own bytes, which content comparison covers.",
  },
  "android-boot-image-entry": {
    notCompared:
      "role and index restate the entry's path, compression is observed from its bytes, and load addresses, names and board IDs come from the image header or vendor ramdisk table, which the image's content comparison covers.",
  },
  "android-ota-payload": {
    notCompared:
      "Its header and manifest facts come from the payload's own bytes, which content comparison covers. Signatures are counted, not verified.",
  },
  "android-ota-partition": {
    notCompared:
      "name and index restate the entry's path; reconstructed partition bytes are compared by content when they are extractable.",
  },
  "esp-image": {
    notCompared:
      "Its fields come from the image's own bytes, which content comparison covers.",
  },
  /**
   * What a segment header declares: where its bytes load and how many there
   * are. Header offsets are layout, and the classification is derived.
   */
  "esp-image-segment": {
    declaration: (metadata) => ({
      load_addr: metadata.load_addr,
      data_len: metadata.data_len,
    }),
  },
  "esp-image-signature-block": {
    notCompared:
      "Its fields come from the block's own bytes, which content comparison covers, and image_digest_matches follows the image's content.",
  },
  uf2: {
    notCompared:
      "Its counts come from the file's own blocks, which content comparison covers, and family_name_registry names REA's label registry.",
  },
  "uf2-region": {
    notCompared:
      "Its familyID and addresses are in its path, family_name is REA's label for the familyID, and its block counts and positions are layout; content comparison covers its bytes.",
  },
  "ntfs-mft": {
    notCompared:
      "Its fields come from the file's own FILE record headers and resident file-name attributes, which content comparison covers.",
  },
  dfuse: {
    notCompared:
      "Its fields come from the file's own prefix, target headers and suffix, which content comparison covers.",
  },
  /** The device memory an element targets, which its path and bytes do not show. */
  "dfuse-element": {
    declaration: (metadata) => ({
      alternate_setting: metadata.alternate_setting,
      target_name: metadata.target_name,
    }),
  },
  "esp-flash-image": {
    notCompared:
      "Its fields come from the dump's bytes and from the caller's flash_offset and partition_table_offset, which are target identity; each partition's range, compared by content, reflects them.",
  },
  /**
   * What a partition entry declares; its index is layout, and the written
   * fields are observed from its bytes, which content comparison covers.
   */
  "esp-flash-partition": {
    declaration: (metadata) => ({
      label: metadata.label,
      label_hex: metadata.label_hex,
      type: metadata.type,
      subtype: metadata.subtype,
      flash_address: metadata.flash_address,
      size: metadata.size,
      encrypted: metadata.encrypted,
      readonly: metadata.readonly,
      unknown_flags: metadata.unknown_flags,
    }),
  },
  fit: {
    notCompared:
      "Its fields come from the FIT's own bytes, which content comparison covers.",
  },
  /**
   * Payload interpretation and sharing declarations, independent of FIT
   * placement: the image's name, index and data position are layout.
   */
  "fit-image": {
    declaration: (metadata) => ({
      type: metadata.type,
      arch: metadata.arch,
      os: metadata.os,
      compression: metadata.compression,
      load: metadata.load,
      entry: metadata.entry,
      image_data: metadata.image_data,
      cipher_present: metadata.cipher_present,
      cipher_algo: metadata.cipher_algo,
    }),
    unreadable: (metadata) => metadata.unreadable_fields,
  },
};

/** Kinds whose declarations artifact comparison compares, in table order. */
export const COMPARED_FORMAT_METADATA_KINDS = Object.entries(
  declarationsByKind,
).flatMap(([kind, entry]) => ("declaration" in entry ? [kind] : []));

/** A declaration that artifact comparison compares within its kind. */
export interface FormatMetadataDeclaration {
  readonly kind: FormatMetadataKind;
  readonly facts: Readonly<Record<string, unknown>>;
  /** Facts whose value is unknown, which compare as neither equal nor changed. */
  readonly unreadable: readonly string[];
}

// Generic in the kind, so each projection receives its own metadata type.
const declarationOf = <Kind extends FormatMetadataKind>(
  kind: Kind,
  metadata: FormatMetadataByKind[Kind],
): FormatMetadataDeclaration | undefined => {
  const entry = declarationsByKind[kind];
  return "declaration" in entry
    ? {
        kind,
        facts: entry.declaration(metadata),
        unreadable: entry.unreadable?.(metadata) ?? [],
      }
    : undefined;
};

/** The compared declaration, or undefined when comparison uses none. */
export const formatMetadataDeclaration = (
  metadata: ArtifactFormatMetadata | undefined,
): FormatMetadataDeclaration | undefined =>
  metadata === undefined ? undefined : declarationOf(metadata.kind, metadata);

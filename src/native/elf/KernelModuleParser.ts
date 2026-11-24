import { createHash } from "node:crypto";
import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../../resources/index.js";
import { allKeyed, firstKeyed, keyedBy } from "../../domain/keyedCollection.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  KERNEL_MODULE_CRC32_ENTRY_BYTES,
  KERNEL_MODULE_VERSION_ENTRY_BYTES,
  kernelModuleModinfoLimit,
  MAX_KERNEL_MODULE_RAW_BYTES,
  MAX_KERNEL_MODULE_SECTION_NAME_BYTES,
  MODULE_SIGNATURE_INFO_BYTES,
  MODULE_SIGNATURE_MAGIC,
  MODULE_SIGNATURE_PKCS7_ID_TYPE,
  type KernelModule,
  type InspectKernelModuleInput,
} from "../../domain/native/kernelModule.js";
import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import {
  BinaryReader,
  type ImageSection,
  type BinaryContainer,
} from "../../domain/binaryContainer.js";
import { readElfImageFromReader } from "../../domain/native/elfImage.js";
import { kernelCompressionCodecAt } from "./KernelCompressionCodec.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import type { ByteSource } from "../../domain/byteSource.js";

type ElfSection = Extract<ImageSection, { format: "elf" }>;
type Report = KernelModule;
type Limitations = string[];

const MAGIC = Buffer.from(MODULE_SIGNATURE_MAGIC, "latin1");
const SIGNATURE_HASH_CHUNK_BYTES = 1 << 20;
const STRING_SCAN_CHECKPOINT_BYTES = 1 << 16;
const MODULE_CODECS = ["gzip", "xz", "zstd"] as const;

interface EntryBudget {
  scanned: number;
  returned: number;
}

const exceeds = (examined: number, maxEntries: number): void => {
  if (examined > maxEntries)
    throw new ArtifactReaderFailure(
      "limit",
      `Kernel module entries exceed the ${String(maxEntries)}-entry budget.`,
      { boundary: "capacity" },
    );
};

const fits = (offset: bigint, size: bigint, fileLength: number): boolean =>
  offset >= 0n &&
  size >= 0n &&
  offset <= BigInt(fileLength) &&
  size <= BigInt(fileLength) - offset;

const locationOf = (
  section: ElfSection,
): { offset: number; bytes: number } | null => {
  if (
    !fits(
      section.declared_range.offset,
      section.declared_range.size,
      Number.MAX_SAFE_INTEGER,
    )
  )
    return null;
  return {
    offset: Number(section.declared_range.offset),
    bytes: Number(section.declared_range.size),
  };
};

const inFile = (section: ElfSection, fileLength: number): boolean =>
  fits(section.declared_range.offset, section.declared_range.size, fileLength);

const rawHex = (bytes: Buffer): string | null =>
  bytes.length > MAX_KERNEL_MODULE_RAW_BYTES ? null : bytes.toString("hex");

const baseLimitations = (): Limitations => [
  "This workflow does not execute the module, resolve imported symbols, or validate an appended signature.",
  "struct module in .gnu.linkonce.this_module is kernel-version specific and is not decoded.",
  "struct kernel_symbol records in __ksymtab* use kernel-version-specific PREL32 or pointer relocations that are not resolved, so decoded __ksymtab_strings entries and __kcrctab / __kcrctab_gpl u32 CRCs are reported in section order without pairing symbol names, namespaces, or GPL visibility.",
  "__kcrctab and __kcrctab_gpl are decoded as 4-byte u32 CRCs in ELF byte order; legacy unsigned-long layouts and pre-relocation placeholder values are not distinguished.",
  "Both classic __versions and CONFIG_EXTENDED_MODVERSIONS (__version_ext_names paired with __version_ext_crcs u32 CRCs) are decoded; their absence in this ELF image does not prove another container or kernel config lacks symbol versioning.",
  "Metadata strings use a byte-preserving Latin1 projection; their original text encoding is unobserved.",
];

const headerFacts = (
  image: Extract<BinaryContainer, { format: "elf" }>,
): Pick<Report, "format" | "byte_order" | "machine" | "type" | "type_name"> => {
  const { type } = image.elf;
  return {
    format: image.bits === 64 ? "elf64" : "elf32",
    byte_order: image.byte_order,
    machine: image.elf.machine,
    type,
    type_name: elfObjectTypeName(type),
  };
};

const unsupportedCompression = (
  artifact: Report["artifact"],
  compression: NonNullable<Report["compression"]>,
): Report => ({
  artifact,
  format: null,
  byte_order: null,
  machine: null,
  type: null,
  type_name: null,
  applicability: "unsupported",
  compression,
  next_probe: {
    operation: "external_decompression",
    rationale: `Decompress this ${compression.codec} container with an external ${compression.codec} utility into a separate file, then call inspect_kernel_module on the decompressed file. REA does not decode ${compression.codec} containers.`,
  },
  modinfo: null,
  versions: null,
  extended_versions: null,
  this_module: null,
  ksymtab: null,
  init_text: null,
  exit_text: null,
  signature: null,
  coverage: { status: "unsupported", examined_entries: 0 },
  limitations: [
    ...baseLimitations(),
    "gzip, xz, and zstd kernel-module containers are not decoded. The existing ELF section decoder does not cover these whole-file codecs.",
    "A compressed container is not proof the payload is a kernel module.",
  ],
});

/** A recognized outer container never enters the ELF image parser. */
const moduleCompressionReport = (
  bytes: Buffer,
  artifact: Report["artifact"],
): Report | null => {
  const codec = kernelCompressionCodecAt(bytes, 0, MODULE_CODECS);
  return codec === null
    ? null
    : unsupportedCompression(artifact, { codec, status: "unsupported" });
};

const notApplicable = (
  artifact: Report["artifact"],
  facts: ReturnType<typeof headerFacts>,
): Report => ({
  artifact,
  ...facts,
  applicability: "not_applicable",
  compression: null,
  next_probe: null,
  modinfo: null,
  versions: null,
  extended_versions: null,
  this_module: null,
  ksymtab: null,
  init_text: null,
  exit_text: null,
  signature: null,
  coverage: { status: "not_applicable", examined_entries: 0 },
  limitations: [
    ...baseLimitations(),
    "Kernel module metadata is defined for ET_REL objects. This ELF type is not applicable, so .modinfo, __versions, CONFIG_EXTENDED_MODVERSIONS, __ksymtab*/__kcrctab*, and the signature trailer were not examined.",
  ],
});

interface SectionUse {
  readonly namesComplete: boolean;
  readonly limitations: Limitations;
}

const parseModinfoStored = (
  stored: Buffer,
  location: { offset: number; bytes: number },
  compressed: boolean,
  use: SectionUse,
  examined: EntryBudget,
  input: InspectKernelModuleInput,
): NonNullable<Report["modinfo"]> => {
  if (compressed)
    return {
      status: "unsupported",
      location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "modinfo_section_compressed",
    };
  const entries: NonNullable<Report["modinfo"]>["entries"] = [];
  let largestKeyBytes = 0;
  let largestValueBytes = 0;
  let at = 0;
  while (at < stored.length) {
    if (stored[at] === 0) {
      at += 1;
      continue;
    }
    const end = stored.indexOf(0, at);
    const terminated = end >= 0;
    const stop = terminated ? end : stored.length;
    const record = stored.subarray(at, stop);
    const raw = stored.subarray(at, terminated ? end + 1 : stored.length);
    examined.scanned += 1;
    examined.returned += 1;
    exceeds(examined.scanned, input.max_entries);
    const separator = record.indexOf(0x3d);
    let key: string | null = null;
    let value: string | null = null;
    const omittedFields: Array<"key" | "value"> = [];
    let reason: NonNullable<Report["modinfo"]>["entries"][number]["reason"] =
      terminated ? null : "unterminated_modinfo_entry";
    if (separator < 0) reason ??= "modinfo_missing_separator";
    else {
      const keyBytes = record.subarray(0, separator);
      const valueBytes = record.subarray(separator + 1);
      largestKeyBytes = Math.max(largestKeyBytes, keyBytes.length);
      largestValueBytes = Math.max(largestValueBytes, valueBytes.length);
      if (keyBytes.length === 0) reason ??= "modinfo_empty_key";
      if (keyBytes.length > input.max_modinfo_key_bytes)
        omittedFields.push("key");
      if (valueBytes.length > input.max_modinfo_value_bytes)
        omittedFields.push("value");
      if (keyBytes.length > 0 && keyBytes.length <= input.max_modinfo_key_bytes)
        key = keyBytes.toString("latin1");
      if (valueBytes.length <= input.max_modinfo_value_bytes)
        value = valueBytes.toString("latin1");
    }
    entries.push({
      index: entries.length,
      location: {
        offset: location.offset + at,
        bytes: raw.length,
      },
      key,
      value,
      raw_sha256: sha256Hex(raw),
      raw_hex: rawHex(raw),
      status: reason === null ? "observed" : "malformed",
      reason,
      omitted_fields: omittedFields,
    });
    if (!terminated) break;
    at = end + 1;
  }
  const omissionLimits: AnalysisParameterLimit[] = [];
  for (const [field, selected, required] of [
    ["key", input.max_modinfo_key_bytes, largestKeyBytes],
    ["value", input.max_modinfo_value_bytes, largestValueBytes],
  ] as const) {
    if (required > selected) {
      omissionLimits.push(kernelModuleModinfoLimit(field, selected));
      use.limitations.push(
        `.modinfo ${field} text exceeds max_modinfo_${field}_bytes=${String(selected)} bytes. Omitted fields keep their source range and digest; omission does not establish malformed syntax. Retry inspect_kernel_module with max_modinfo_${field}_bytes at least ${String(required)}; modinfo.omission_limits records the control. Applies on the next call without a REA restart; input, entry and raw-hex budgets do not change.`,
      );
    }
  }
  return {
    status: "present",
    location,
    sha256: sha256Hex(stored),
    entries,
    reason: null,
    ...(omissionLimits.length === 0 ? {} : { omission_limits: omissionLimits }),
  };
};

const parseVersionsStored = (
  stored: Buffer,
  location: { offset: number; bytes: number },
  compressed: boolean,
  bits: 32 | 64,
  little: boolean,
  examined: EntryBudget,
  maxEntries: number,
): NonNullable<Report["versions"]> => {
  const layout =
    bits === 64 ? "elf64_unsigned_long_name56" : "elf32_unsigned_long_name60";
  const entryBytes = KERNEL_MODULE_VERSION_ENTRY_BYTES;
  if (compressed)
    return {
      status: "unsupported",
      layout,
      entry_bytes: entryBytes,
      location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "versions_section_compressed",
    };
  if (stored.length % entryBytes !== 0)
    return {
      status: "malformed",
      layout,
      entry_bytes: entryBytes,
      location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "versions_size_not_multiple",
    };
  const nameBytes = bits === 64 ? 56 : 60;
  const crcBytes = bits === 64 ? 8 : 4;
  const reader = new BinaryReader(stored, little, "elf");
  const count = stored.length / entryBytes;
  exceeds(examined.scanned + count, maxEntries);
  const entries: NonNullable<Report["versions"]>["entries"] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * entryBytes;
    const record = stored.subarray(start, start + entryBytes);
    const crc = reader.word(start, bits);
    const nameField = record.subarray(crcBytes, crcBytes + nameBytes);
    const end = nameField.indexOf(0);
    entries.push({
      index,
      location: { offset: location.offset + start, bytes: entryBytes },
      crc_hex: crc.toString(16).padStart(crcBytes * 2, "0"),
      name: end < 0 ? null : nameField.subarray(0, end).toString("latin1"),
      status: end < 0 ? "malformed" : "observed",
      reason: end < 0 ? "version_name_unterminated" : null,
    });
  }
  examined.scanned += count;
  examined.returned += count;
  return {
    status: "present",
    layout,
    entry_bytes: entryBytes,
    location,
    sha256: sha256Hex(stored),
    entries,
    reason: null,
  };
};

const presence = (
  section: ElfSection | undefined,
  namesComplete: boolean,
  fileLength: number,
): {
  readonly status: "present" | "absent" | "unknown" | "unsupported";
  readonly location: { offset: number; bytes: number } | null;
} => {
  if (section === undefined)
    return { status: namesComplete ? "absent" : "unknown", location: null };
  if (section.type === 8 || !inFile(section, fileLength))
    return { status: "present", location: null };
  const location = locationOf(section);
  if (section.compressed) return { status: "unsupported", location };
  return { status: "present", location };
};

const sized = (
  fileLength: number,
  section: ElfSection | undefined,
  namesComplete: boolean,
  limitations: Limitations,
  label: string,
): NonNullable<Report["init_text"]> => {
  if (section === undefined)
    return {
      status: namesComplete ? "absent" : "unknown",
      location: null,
      bytes: null,
      compressed: null,
    };
  if (!inFile(section, fileLength) || section.type === 8) {
    limitations.push(
      `${label} is declared but not file-backed, so its size is unknown.`,
    );
    return {
      status: "present",
      location: null,
      bytes: null,
      compressed: null,
    };
  }
  const location = locationOf(section);
  if (section.compressed)
    limitations.push(
      `${label} is stored compressed. The reported size is the file-backed storage size; the decoded size is unknown.`,
    );
  return {
    status: "present",
    location,
    bytes: location?.bytes ?? null,
    compressed: section.compressed,
  };
};

const parseSignatureTrailer = (
  fileLength: number,
  tail: Buffer,
):
  | { readonly done: true; readonly signature: Report["signature"] }
  | {
      readonly done: false;
      readonly magic: { offset: number; bytes: number };
      readonly info: NonNullable<NonNullable<Report["signature"]>["info"]>;
      readonly pkcs7Offset: number;
      readonly pkcs7Bytes: number;
    } => {
  if (
    fileLength < MAGIC.length ||
    !tail.subarray(tail.length - MAGIC.length).equals(MAGIC)
  )
    return {
      done: true,
      signature: {
        status: "absent",
        magic: null,
        info: null,
        pkcs7: null,
        reason: null,
      },
    };
  const magic = {
    offset: fileLength - MAGIC.length,
    bytes: MAGIC.length,
  };
  if (magic.offset < MODULE_SIGNATURE_INFO_BYTES)
    return {
      done: true,
      signature: {
        status: "malformed",
        magic,
        info: null,
        pkcs7: null,
        reason: "signature_trailer_truncated",
      },
    };
  const infoOffset = magic.offset - MODULE_SIGNATURE_INFO_BYTES;
  const infoSlice = tail.subarray(
    tail.length - MAGIC.length - MODULE_SIGNATURE_INFO_BYTES,
    tail.length - MAGIC.length,
  );
  const footer = new BinaryReader(infoSlice, false, "elf");
  const info = {
    location: { offset: infoOffset, bytes: MODULE_SIGNATURE_INFO_BYTES },
    algo: footer.u8(0),
    hash: footer.u8(1),
    id_type: footer.u8(2),
    signer_len: footer.u8(3),
    key_id_len: footer.u8(4),
    pad: [footer.u8(5), footer.u8(6), footer.u8(7)] as [number, number, number],
    sig_len: footer.u32(8),
  };
  const isPkcs7 = info.id_type === MODULE_SIGNATURE_PKCS7_ID_TYPE;
  if (info.sig_len >= infoOffset || (isPkcs7 && info.sig_len === 0))
    return {
      done: true,
      signature: {
        status: "malformed",
        magic,
        info,
        pkcs7: null,
        reason: "signature_length_inconsistent",
      },
    };
  if (!isPkcs7)
    return {
      done: true,
      signature: {
        status: "unsupported",
        magic,
        info,
        pkcs7: null,
        reason: "signature_id_type_not_pkcs7",
      },
    };
  const parametersNonzero =
    info.algo !== 0 ||
    info.hash !== 0 ||
    info.signer_len !== 0 ||
    info.key_id_len !== 0 ||
    info.pad.some((value) => value !== 0);
  if (parametersNonzero)
    return {
      done: true,
      signature: {
        status: "malformed",
        magic,
        info,
        pkcs7: null,
        reason: "signature_parameters_nonzero",
      },
    };
  return {
    done: false,
    magic,
    info,
    pkcs7Offset: infoOffset - info.sig_len,
    pkcs7Bytes: info.sig_len,
  };
};

const readSourceRange = async (
  source: ByteSource,
  offset: number,
  length: number,
): Promise<Buffer> => {
  if (length === 0) return Buffer.alloc(0);
  const { prefix } = source;
  if (prefix !== undefined && offset + length <= prefix.length)
    return prefix.subarray(offset, offset + length);
  const bytes = await source.readRange(offset, length);
  if (bytes.length !== length)
    throw new ArtifactReaderFailure(
      "integrity",
      "Kernel module ended before the admitted file range.",
      { integrityCheck: "read-coverage" },
    );
  return bytes;
};

const parseSignatureFromSource = async (
  source: ByteSource,
  signal: AbortSignal | undefined,
): Promise<Report["signature"]> => {
  const tailLen = Math.min(
    source.size,
    MAGIC.length + MODULE_SIGNATURE_INFO_BYTES,
  );
  const tail = await readSourceRange(source, source.size - tailLen, tailLen);
  const trailer = parseSignatureTrailer(source.size, tail);
  if (trailer.done) return trailer.signature;

  const hash = createHash("sha256");
  const end = trailer.pkcs7Offset + trailer.pkcs7Bytes;
  for (let offset = trailer.pkcs7Offset; offset < end;) {
    assertArtifactReadActive(signal);
    const length = Math.min(end - offset, SIGNATURE_HASH_CHUNK_BYTES);
    hash.update(await readSourceRange(source, offset, length));
    offset += length;
  }
  return {
    status: "present",
    magic: trailer.magic,
    info: trailer.info,
    pkcs7: {
      location: { offset: trailer.pkcs7Offset, bytes: trailer.pkcs7Bytes },
      sha256: hash.digest("hex"),
    },
    reason: null,
  };
};

const signatureLimitation = (signature: Report["signature"]): string => {
  if (signature?.status === "absent")
    return "No '~Module signature appended~' trailer was present. That is not proof the module is unsigned in another container.";
  if (signature?.status === "present")
    return "PKCS#7 bytes are identified by the module_signature trailer and hashed. Certificate chain, signer, and digest coverage are unobserved.";
  return "The appended signature trailer was not accepted as an unvalidated PKCS#7 range.";
};

type Range = { offset: number; bytes: number };

type SectionDescriptor =
  | { readonly state: "missing"; readonly status: "absent" | "unknown" }
  | { readonly state: "not_file_backed" }
  | {
      readonly state: "ready";
      readonly location: Range;
      readonly compressed: boolean;
    };

const describeSection = (
  section: ElfSection | undefined,
  fileLength: number,
  namesComplete: boolean,
): SectionDescriptor => {
  if (section === undefined)
    return { state: "missing", status: namesComplete ? "absent" : "unknown" };
  const location = locationOf(section);
  if (section.type === 8 || location === null || !inFile(section, fileLength))
    return { state: "not_file_backed" };
  return { state: "ready", location, compressed: section.compressed };
};

const omittedTextLimitation = (
  limitations: Limitations,
  sectionName: string,
  count: number,
): void => {
  if (count > 0)
    limitations.push(
      `${String(count)} ${sectionName} entry/entries exceed ${String(MAX_KERNEL_MODULE_RAW_BYTES)} bytes and had text omitted while retaining source range and SHA-256; omission does not establish malformed syntax.`,
    );
};

const modinfoSectionLocation = (
  section: ElfSection | undefined,
  fileLength: number,
  use: SectionUse,
):
  | { readonly ready: false; readonly result: NonNullable<Report["modinfo"]> }
  | {
      readonly ready: true;
      readonly location: Range;
      readonly compressed: boolean;
    } => {
  const desc = describeSection(section, fileLength, use.namesComplete);
  if (desc.state === "missing")
    return {
      ready: false,
      result: {
        status: desc.status,
        location: null,
        sha256: null,
        entries: [],
        reason: null,
      },
    };
  if (desc.state === "not_file_backed")
    return {
      ready: false,
      result: {
        status: "malformed",
        location: null,
        sha256: null,
        entries: [],
        reason: "modinfo_section_not_file_backed",
      },
    };
  return { ready: true, location: desc.location, compressed: desc.compressed };
};

const versionsSectionLocation = (
  section: ElfSection | undefined,
  fileLength: number,
  bits: 32 | 64,
  use: SectionUse,
):
  | { readonly ready: false; readonly result: NonNullable<Report["versions"]> }
  | {
      readonly ready: true;
      readonly location: Range;
      readonly compressed: boolean;
    } => {
  const layout =
    bits === 64 ? "elf64_unsigned_long_name56" : "elf32_unsigned_long_name60";
  const entryBytes = KERNEL_MODULE_VERSION_ENTRY_BYTES;
  const desc = describeSection(section, fileLength, use.namesComplete);
  if (desc.state === "missing")
    return {
      ready: false,
      result: {
        status: desc.status,
        layout,
        entry_bytes: entryBytes,
        location: null,
        sha256: null,
        entries: [],
        reason: null,
      },
    };
  if (desc.state === "not_file_backed")
    return {
      ready: false,
      result: {
        status: "malformed",
        layout,
        entry_bytes: entryBytes,
        location: null,
        sha256: null,
        entries: [],
        reason: "versions_section_not_file_backed",
      },
    };
  return { ready: true, location: desc.location, compressed: desc.compressed };
};

const decodeU32CrcEntries = (
  stored: Buffer,
  baseOffset: number,
  little: boolean,
): NonNullable<
  NonNullable<NonNullable<Report["ksymtab"]>["kcrctab"]>["entries"]
> => {
  const count = stored.length / KERNEL_MODULE_CRC32_ENTRY_BYTES;
  const reader = new BinaryReader(stored, little, "elf");
  const entries: NonNullable<
    NonNullable<NonNullable<Report["ksymtab"]>["kcrctab"]>["entries"]
  > = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * KERNEL_MODULE_CRC32_ENTRY_BYTES;
    const crc = reader.u32(start);
    entries.push({
      index,
      location: {
        offset: baseOffset + start,
        bytes: KERNEL_MODULE_CRC32_ENTRY_BYTES,
      },
      crc_hex: crc.toString(16).padStart(8, "0"),
    });
  }
  return entries;
};

const advancePastNulPadding = async (
  bytes: Buffer,
  start: number,
  checkpoint: { next: number },
  pause: () => Promise<void>,
): Promise<number> => {
  let at = start;
  while (at < bytes.length && bytes[at] === 0) {
    if (at >= checkpoint.next) {
      await pause();
      checkpoint.next = at + STRING_SCAN_CHECKPOINT_BYTES;
    }
    at += 1;
  }
  if (at >= checkpoint.next) {
    await pause();
    checkpoint.next = at + STRING_SCAN_CHECKPOINT_BYTES;
  }
  return at;
};

const parseKsymtabStrings = async (
  source: ByteSource,
  section: ElfSection | undefined,
  fileLength: number,
  use: SectionUse,
  examined: EntryBudget,
  maxEntries: number,
  pause: () => Promise<void>,
): Promise<NonNullable<NonNullable<Report["ksymtab"]>["strings"]>> => {
  const desc = describeSection(section, fileLength, use.namesComplete);
  if (desc.state === "missing")
    return {
      status: desc.status,
      location: null,
      sha256: null,
      entries: [],
      reason: null,
    };
  if (desc.state === "not_file_backed") {
    use.limitations.push(
      "__ksymtab_strings is declared but not file-backed, so exported symbol strings could not be read.",
    );
    return {
      status: "malformed",
      location: null,
      sha256: null,
      entries: [],
      reason: "ksymtab_strings_section_not_file_backed",
    };
  }
  const stored = await readSourceRange(
    source,
    desc.location.offset,
    desc.location.bytes,
  );
  if (desc.compressed) {
    use.limitations.push(
      "__ksymtab_strings is stored compressed and is not inflated.",
    );
    return {
      status: "unsupported",
      location: desc.location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "ksymtab_strings_section_compressed",
    };
  }
  const entries: NonNullable<
    NonNullable<Report["ksymtab"]>["strings"]
  >["entries"] = [];
  const checkpoint = { next: STRING_SCAN_CHECKPOINT_BYTES };
  let omittedCount = 0;
  let unterminated = false;
  let at = 0;
  while (at < stored.length) {
    if (at >= checkpoint.next) {
      await pause();
      checkpoint.next = at + STRING_SCAN_CHECKPOINT_BYTES;
    }
    if (stored[at] === 0) {
      at = await advancePastNulPadding(stored, at, checkpoint, pause);
      if (at >= stored.length) break;
    }
    const end = stored.indexOf(0, at);
    const terminated = end >= 0;
    const stop = terminated ? end : stored.length;
    const textBytes = stored.subarray(at, stop);
    const raw = stored.subarray(at, terminated ? end + 1 : stored.length);
    examined.scanned += 1;
    examined.returned += 1;
    exceeds(examined.scanned, maxEntries);
    const omitted =
      terminated && textBytes.length > MAX_KERNEL_MODULE_RAW_BYTES;
    if (omitted) omittedCount += 1;
    if (!terminated) unterminated = true;
    entries.push({
      index: entries.length,
      location: { offset: desc.location.offset + at, bytes: raw.length },
      value: terminated && !omitted ? textBytes.toString("latin1") : null,
      raw_sha256: sha256Hex(raw),
      raw_hex: rawHex(raw),
      status: terminated ? "observed" : "malformed",
      reason: terminated ? null : "ksymtab_string_unterminated",
      omitted,
    });
    if (!terminated) break;
    at = end + 1;
  }
  omittedTextLimitation(use.limitations, "__ksymtab_strings", omittedCount);
  if (unterminated)
    use.limitations.push(
      "__ksymtab_strings ended without a terminating NUL byte.",
    );
  return {
    status: "present",
    location: desc.location,
    sha256: sha256Hex(stored),
    entries,
    reason: null,
  };
};

const parseKcrctabSection = async (
  source: ByteSource,
  section: ElfSection | undefined,
  label: "__kcrctab" | "__kcrctab_gpl",
  fileLength: number,
  little: boolean,
  use: SectionUse,
  examined: EntryBudget,
  maxEntries: number,
): Promise<NonNullable<NonNullable<Report["ksymtab"]>["kcrctab"]>> => {
  const entryBytes = KERNEL_MODULE_CRC32_ENTRY_BYTES;
  const desc = describeSection(section, fileLength, use.namesComplete);
  if (desc.state === "missing")
    return {
      status: desc.status,
      entry_bytes: entryBytes,
      location: null,
      sha256: null,
      entries: [],
      reason: null,
    };
  if (desc.state === "not_file_backed") {
    use.limitations.push(
      `${label} is declared but not file-backed, so exported symbol CRCs could not be read.`,
    );
    return {
      status: "malformed",
      entry_bytes: entryBytes,
      location: null,
      sha256: null,
      entries: [],
      reason: "kcrctab_section_not_file_backed",
    };
  }
  if (!desc.compressed && desc.location.bytes % entryBytes === 0)
    exceeds(examined.scanned + desc.location.bytes / entryBytes, maxEntries);
  const stored = await readSourceRange(
    source,
    desc.location.offset,
    desc.location.bytes,
  );
  if (desc.compressed) {
    use.limitations.push(`${label} is stored compressed and is not inflated.`);
    return {
      status: "unsupported",
      entry_bytes: entryBytes,
      location: desc.location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "kcrctab_section_compressed",
    };
  }
  if (stored.length % entryBytes !== 0) {
    use.limitations.push(
      `${label} byte size (${String(stored.length)}) is not a multiple of ${String(entryBytes)}; CRC entries were withheld.`,
    );
    return {
      status: "malformed",
      entry_bytes: entryBytes,
      location: desc.location,
      sha256: sha256Hex(stored),
      entries: [],
      reason: "kcrctab_size_not_multiple",
    };
  }
  const entries = decodeU32CrcEntries(stored, desc.location.offset, little);
  examined.scanned += entries.length;
  examined.returned += entries.length;
  return {
    status: "present",
    entry_bytes: entryBytes,
    location: desc.location,
    sha256: sha256Hex(stored),
    entries,
    reason: null,
  };
};

interface ScannedExtNameSpan {
  readonly start: number;
  readonly raw: Buffer;
  readonly content: Buffer;
  readonly terminated: boolean;
}

const parseExtendedVersions = async (
  source: ByteSource,
  namesSection: ElfSection | undefined,
  crcsSection: ElfSection | undefined,
  fileLength: number,
  little: boolean,
  use: SectionUse,
  examined: EntryBudget,
  maxEntries: number,
  pause: () => Promise<void>,
): Promise<NonNullable<Report["extended_versions"]>> => {
  const entryCrcBytes = KERNEL_MODULE_CRC32_ENTRY_BYTES;
  const namesDesc = describeSection(
    namesSection,
    fileLength,
    use.namesComplete,
  );
  const crcsDesc = describeSection(crcsSection, fileLength, use.namesComplete);
  if (namesDesc.state === "missing" && crcsDesc.state === "missing") {
    const emptyMeta = {
      status: namesDesc.status,
      location: null,
      sha256: null,
      count: null,
      reason: null,
    };
    return {
      status: namesDesc.status,
      entry_crc_bytes: entryCrcBytes,
      names_section: emptyMeta,
      crcs_section: emptyMeta,
      entries: [],
      reason: null,
    };
  }
  if (
    namesDesc.state === "ready" &&
    !namesDesc.compressed &&
    crcsDesc.state === "ready" &&
    !crcsDesc.compressed &&
    crcsDesc.location.bytes % entryCrcBytes === 0
  ) {
    exceeds(
      examined.scanned + crcsDesc.location.bytes / entryCrcBytes,
      maxEntries,
    );
  }
  type ExtMeta = NonNullable<Report["extended_versions"]>["names_section"];
  let namesStored: Buffer | undefined;
  let namesLoc: Range | null = null;
  let namesMeta: ExtMeta;
  if (namesDesc.state === "missing") {
    namesMeta = {
      status: namesDesc.status,
      location: null,
      sha256: null,
      count: null,
      reason: null,
    };
  } else if (namesDesc.state === "not_file_backed") {
    use.limitations.push(
      "__version_ext_names is declared but not file-backed, so extended modversions names could not be read.",
    );
    namesMeta = {
      status: "malformed",
      location: null,
      sha256: null,
      count: null,
      reason: "version_ext_names_not_file_backed",
    };
  } else {
    const stored = await readSourceRange(
      source,
      namesDesc.location.offset,
      namesDesc.location.bytes,
    );
    if (namesDesc.compressed) {
      use.limitations.push(
        "__version_ext_names is stored compressed and is not inflated.",
      );
      namesMeta = {
        status: "unsupported",
        location: namesDesc.location,
        sha256: sha256Hex(stored),
        count: null,
        reason: "version_ext_names_compressed",
      };
    } else {
      namesStored = stored;
      namesLoc = namesDesc.location;
      namesMeta = {
        status: "present",
        location: namesDesc.location,
        sha256: sha256Hex(stored),
        count: null,
        reason: null,
      };
    }
  }
  let crcsStored: Buffer | undefined;
  let crcsLoc: Range | null = null;
  let crcsMeta: ExtMeta;
  if (crcsDesc.state === "missing") {
    crcsMeta = {
      status: crcsDesc.status,
      location: null,
      sha256: null,
      count: null,
      reason: null,
    };
  } else if (crcsDesc.state === "not_file_backed") {
    use.limitations.push(
      "__version_ext_crcs is declared but not file-backed, so extended modversions CRCs could not be read.",
    );
    crcsMeta = {
      status: "malformed",
      location: null,
      sha256: null,
      count: null,
      reason: "version_ext_crcs_not_file_backed",
    };
  } else {
    const stored = await readSourceRange(
      source,
      crcsDesc.location.offset,
      crcsDesc.location.bytes,
    );
    if (crcsDesc.compressed) {
      use.limitations.push(
        "__version_ext_crcs is stored compressed and is not inflated.",
      );
      crcsMeta = {
        status: "unsupported",
        location: crcsDesc.location,
        sha256: sha256Hex(stored),
        count: null,
        reason: "version_ext_crcs_compressed",
      };
    } else if (stored.length % entryCrcBytes !== 0) {
      use.limitations.push(
        `__version_ext_crcs byte size (${String(stored.length)}) is not a multiple of ${String(entryCrcBytes)}; extended modversions were withheld.`,
      );
      crcsMeta = {
        status: "malformed",
        location: crcsDesc.location,
        sha256: sha256Hex(stored),
        count: null,
        reason: "version_ext_crcs_size_not_multiple",
      };
    } else {
      crcsStored = stored;
      crcsLoc = crcsDesc.location;
      crcsMeta = {
        status: "present",
        location: crcsDesc.location,
        sha256: sha256Hex(stored),
        count: stored.length / entryCrcBytes,
        reason: null,
      };
    }
  }
  if (
    namesStored === undefined ||
    namesLoc === null ||
    crcsStored === undefined ||
    crcsLoc === null
  ) {
    if (namesMeta.status === "absent")
      use.limitations.push(
        "__version_ext_crcs is declared without __version_ext_names; CONFIG_EXTENDED_MODVERSIONS requires both sections.",
      );
    else if (crcsMeta.status === "absent")
      use.limitations.push(
        "__version_ext_names is declared without __version_ext_crcs; CONFIG_EXTENDED_MODVERSIONS requires both sections.",
      );
    else if (namesMeta.status === "unknown" || crcsMeta.status === "unknown")
      use.limitations.push(
        "Section names are incomplete, so the missing CONFIG_EXTENDED_MODVERSIONS section is unknown rather than absent.",
      );
    const closedStatus =
      namesMeta.status === "malformed" || crcsMeta.status === "malformed"
        ? ("malformed" as const)
        : namesMeta.status === "unsupported" ||
            crcsMeta.status === "unsupported"
          ? ("unsupported" as const)
          : namesMeta.status === "absent" || crcsMeta.status === "absent"
            ? ("malformed" as const)
            : ("unknown" as const);
    const closedReason =
      namesMeta.status === "malformed"
        ? namesMeta.reason
        : crcsMeta.status === "malformed"
          ? crcsMeta.reason
          : namesMeta.status === "unsupported"
            ? namesMeta.reason
            : crcsMeta.status === "unsupported"
              ? crcsMeta.reason
              : namesMeta.status === "absent"
                ? ("version_ext_names_missing" as const)
                : crcsMeta.status === "absent"
                  ? ("version_ext_crcs_missing" as const)
                  : null;
    return {
      status: closedStatus,
      entry_crc_bytes: entryCrcBytes,
      names_section: namesMeta,
      crcs_section: crcsMeta,
      entries: [],
      reason: closedReason,
    };
  }
  const crcCount = crcsStored.length / entryCrcBytes;
  exceeds(examined.scanned + crcCount, maxEntries);
  const checkpoint = { next: STRING_SCAN_CHECKPOINT_BYTES };
  const spans: ScannedExtNameSpan[] = [];
  let at = 0;
  while (spans.length < crcCount && at < namesStored.length) {
    if (at >= checkpoint.next) {
      await pause();
      checkpoint.next = at + STRING_SCAN_CHECKPOINT_BYTES;
    }
    const end = namesStored.indexOf(0, at);
    const terminated = end >= 0;
    const stop = terminated ? end : namesStored.length;
    spans.push({
      start: at,
      raw: namesStored.subarray(at, terminated ? end + 1 : namesStored.length),
      content: namesStored.subarray(at, stop),
      terminated,
    });
    at = terminated ? end + 1 : namesStored.length;
  }
  let extraNames = 0;
  while (at < namesStored.length) {
    if (at >= checkpoint.next) {
      await pause();
      checkpoint.next = at + STRING_SCAN_CHECKPOINT_BYTES;
    }
    if (namesStored[at] === 0) {
      at = await advancePastNulPadding(namesStored, at, checkpoint, pause);
      if (at >= namesStored.length) break;
    }
    const end = namesStored.indexOf(0, at);
    extraNames += 1;
    exceeds(examined.scanned + crcCount + extraNames, maxEntries);
    if (end < 0) break;
    at = end + 1;
  }
  const nameCount = spans.length + extraNames;
  if (nameCount !== crcCount) {
    examined.scanned += Math.max(crcCount, nameCount);
    exceeds(examined.scanned, maxEntries);
    use.limitations.push(
      `CONFIG_EXTENDED_MODVERSIONS count mismatch: __version_ext_names has ${String(nameCount)} entry/entries while __version_ext_crcs has ${String(crcCount)} u32 CRC(s); paired entries were withheld.`,
    );
    return {
      status: "malformed",
      entry_crc_bytes: entryCrcBytes,
      names_section: { ...namesMeta, count: nameCount },
      crcs_section: { ...crcsMeta, count: crcCount },
      entries: [],
      reason: "version_ext_count_mismatch",
    };
  }
  const crcReader = new BinaryReader(crcsStored, little, "elf");
  const entries: NonNullable<Report["extended_versions"]>["entries"] = [];
  let omittedCount = 0;
  let malformedCount = 0;
  let hashedBytes = 0;
  let nextHashedCheckpoint = STRING_SCAN_CHECKPOINT_BYTES;
  for (let index = 0; index < crcCount; index += 1) {
    const span = spans[index]!;
    hashedBytes += span.raw.length;
    if (hashedBytes >= nextHashedCheckpoint) {
      await pause();
      nextHashedCheckpoint = hashedBytes + STRING_SCAN_CHECKPOINT_BYTES;
    }
    const crcOffset = crcsLoc.offset + index * entryCrcBytes;
    const crcHex = crcReader
      .u32(index * entryCrcBytes)
      .toString(16)
      .padStart(8, "0");
    const omitted =
      span.terminated &&
      span.content.length > 0 &&
      span.content.length > MAX_KERNEL_MODULE_RAW_BYTES;
    const reason: NonNullable<
      Report["extended_versions"]
    >["entries"][number]["reason"] = !span.terminated
      ? "version_ext_name_unterminated"
      : span.content.length === 0
        ? "version_ext_empty_name"
        : null;
    if (reason !== null) malformedCount += 1;
    if (omitted) omittedCount += 1;
    entries.push({
      index,
      crc_hex: crcHex,
      crc_location: { offset: crcOffset, bytes: entryCrcBytes },
      name:
        reason === null && !omitted ? span.content.toString("latin1") : null,
      name_location: {
        offset: namesLoc.offset + span.start,
        bytes: span.raw.length,
      },
      name_sha256: sha256Hex(span.raw),
      name_raw_hex: rawHex(span.raw),
      status: reason === null ? "observed" : "malformed",
      reason,
      omitted,
    });
  }
  examined.scanned += entries.length;
  examined.returned += entries.length;
  omittedTextLimitation(use.limitations, "__version_ext_names", omittedCount);
  if (malformedCount > 0)
    use.limitations.push(
      `${String(malformedCount)} CONFIG_EXTENDED_MODVERSIONS entry/entries had empty or unterminated symbol names.`,
    );
  return {
    status: "present",
    entry_crc_bytes: entryCrcBytes,
    names_section: { ...namesMeta, count: crcCount },
    crcs_section: { ...crcsMeta, count: crcCount },
    entries,
    reason: null,
  };
};

interface KernelModulePrepared {
  readonly facts: ReturnType<typeof headerFacts>;
  readonly sections: readonly ElfSection[];
  readonly namesComplete: boolean;
  readonly limitations: Limitations;
  readonly use: SectionUse;
  readonly examined: EntryBudget;
  readonly duplicateSections: () => boolean;
  readonly modinfoSection: ElfSection | undefined;
  readonly versionsSection: ElfSection | undefined;
  readonly extVersionNamesSection: ElfSection | undefined;
  readonly extVersionCrcsSection: ElfSection | undefined;
  readonly ksymtabStringsSection: ElfSection | undefined;
  readonly kcrctabSection: ElfSection | undefined;
  readonly kcrctabGplSection: ElfSection | undefined;
  readonly firstNamedSection: (name: string) => ElfSection | undefined;
}

const prepareKernelModule = (
  image: Extract<BinaryContainer, { format: "elf" }>,
): KernelModulePrepared => {
  const facts = headerFacts(image);
  const sections = image.sections.filter(
    (section): section is ElfSection => section.format === "elf",
  );
  const namesComplete =
    image.section_names_limitation === undefined &&
    sections.every((section) => section.name !== null);
  const limitations = baseLimitations();
  if (image.section_names_limitation !== undefined)
    limitations.push(image.section_names_limitation);
  const use = { namesComplete, limitations };
  const examined: EntryBudget = { scanned: 0, returned: 0 };
  let duplicateSections = false;
  const byName = keyedBy(sections, ({ name }) => name);
  const firstNamedSection = (name: string): ElfSection | undefined => {
    if (allKeyed(byName, name).length > 1) {
      duplicateSections = true;
      limitations.push(
        `Multiple ${name} sections are declared; the first is examined.`,
      );
    }
    return firstKeyed(
      byName,
      name,
      "Linux's module loader (find_sec) reads the first section with the name.",
    );
  };
  const modinfoSection = firstNamedSection(".modinfo");
  const versionsSection = firstNamedSection("__versions");
  const extVersionNamesSection = firstNamedSection("__version_ext_names");
  const extVersionCrcsSection = firstNamedSection("__version_ext_crcs");
  const ksymtabStringsSection = firstNamedSection("__ksymtab_strings");
  const kcrctabSection = firstNamedSection("__kcrctab");
  const kcrctabGplSection = firstNamedSection("__kcrctab_gpl");
  return {
    facts,
    sections,
    namesComplete,
    limitations,
    use,
    examined,
    duplicateSections: () => duplicateSections,
    modinfoSection,
    versionsSection,
    extVersionNamesSection,
    extVersionCrcsSection,
    ksymtabStringsSection,
    kcrctabSection,
    kcrctabGplSection,
    firstNamedSection,
  };
};

const finalizeKernelModule = (
  fileLength: number,
  artifact: Report["artifact"],
  input: InspectKernelModuleInput,
  prepared: KernelModulePrepared,
  modinfo: NonNullable<Report["modinfo"]>,
  versions: NonNullable<Report["versions"]>,
  extendedVersions: NonNullable<Report["extended_versions"]>,
  ksymtabStrings: NonNullable<NonNullable<Report["ksymtab"]>["strings"]>,
  kcrctab: NonNullable<NonNullable<Report["ksymtab"]>["kcrctab"]>,
  kcrctabGpl: NonNullable<NonNullable<Report["ksymtab"]>["kcrctab_gpl"]>,
  signature: Report["signature"],
): Report => {
  const {
    facts,
    sections,
    namesComplete,
    limitations,
    examined,
    firstNamedSection,
  } = prepared;
  const modulePresence = presence(
    firstNamedSection(".gnu.linkonce.this_module"),
    namesComplete,
    fileLength,
  );
  const ksymtabNamed = sections.filter(
    (section) => section.name?.startsWith("__ksymtab") === true,
  );
  const ksymtabSections = ksymtabNamed.filter(
    (section) => section.type !== 8 && inFile(section, fileLength),
  );
  const unbacked = ksymtabNamed.length - ksymtabSections.length;
  if (unbacked > 0)
    limitations.push(
      `${String(unbacked)} __ksymtab* section(s) are declared but not file-backed, so their ranges are unknown.`,
    );
  const ksymtab = ksymtabSections.flatMap((section) => {
    const location = locationOf(section);
    if (section.name === null || location === null) return [];
    const fitsName =
      section.name.length <= MAX_KERNEL_MODULE_SECTION_NAME_BYTES;
    return [
      {
        name: fitsName ? section.name : null,
        location,
        compressed: section.compressed,
        reason: fitsName ? null : ("ksymtab_name_exceeds_limit" as const),
      },
    ];
  });
  // Each listed section repeats its name, so the list shares the entry budget.
  examined.scanned += ksymtab.length;
  examined.returned += ksymtab.length;
  exceeds(examined.scanned, input.max_entries);
  const otherKcrctab = sections.some(
    (section) =>
      section.name?.startsWith("__kcrctab") === true &&
      section.name !== "__kcrctab" &&
      section.name !== "__kcrctab_gpl",
  );
  if (otherKcrctab)
    limitations.push(
      "Additional __kcrctab* sections beyond __kcrctab and __kcrctab_gpl were declared and are not decoded.",
    );
  if (!namesComplete)
    limitations.push(
      "Section names are incomplete, so a missing .modinfo, __versions, __version_ext_names, __version_ext_crcs, this_module, __ksymtab, __ksymtab_strings, __kcrctab, __kcrctab_gpl, .init.text, or .exit.text section is unknown rather than absent.",
    );
  if (modinfo.status === "absent")
    limitations.push("No .modinfo section was declared.");
  if (versions.status === "absent")
    limitations.push("No __versions section was declared.");
  limitations.push(signatureLimitation(signature));
  const initText = sized(
    fileLength,
    firstNamedSection(".init.text"),
    namesComplete,
    limitations,
    ".init.text",
  );
  const exitText = sized(
    fileLength,
    firstNamedSection(".exit.text"),
    namesComplete,
    limitations,
    ".exit.text",
  );
  const sectionIncomplete = (section: {
    readonly status: string;
    readonly entries: readonly { readonly status: string }[];
  }) =>
    (section.status !== "present" && section.status !== "absent") ||
    section.entries.some((entry) => entry.status !== "observed");
  const kcrctabIncomplete = (section: { readonly status: string }) =>
    section.status !== "present" && section.status !== "absent";
  const coveragePartial =
    !namesComplete ||
    prepared.duplicateSections() ||
    unbacked > 0 ||
    ksymtab.some((section) => section.reason !== null) ||
    sectionIncomplete(modinfo) ||
    modinfo.entries.some((entry) => entry.omitted_fields.length > 0) ||
    sectionIncomplete(versions) ||
    sectionIncomplete(extendedVersions) ||
    extendedVersions.entries.some((entry) => entry.omitted) ||
    sectionIncomplete(ksymtabStrings) ||
    ksymtabStrings.entries.some((entry) => entry.omitted) ||
    kcrctabIncomplete(kcrctab) ||
    kcrctabIncomplete(kcrctabGpl) ||
    modulePresence.status === "unsupported" ||
    (modulePresence.status === "present" && modulePresence.location === null) ||
    (initText?.status === "present" && initText.bytes === null) ||
    (exitText?.status === "present" && exitText.bytes === null) ||
    signature?.status === "malformed" ||
    signature?.status === "unsupported";
  return {
    artifact,
    ...facts,
    applicability: "applicable",
    compression: null,
    next_probe: null,
    modinfo,
    versions,
    extended_versions: extendedVersions,
    this_module: {
      status: modulePresence.status,
      location: modulePresence.location,
      layout: "unknown",
    },
    ksymtab: {
      status: namesComplete ? "observed" : "unknown",
      sections: ksymtab,
      strings: ksymtabStrings,
      kcrctab,
      kcrctab_gpl: kcrctabGpl,
    },
    init_text: initText,
    exit_text: exitText,
    signature,
    coverage: {
      status: coveragePartial ? "partial" : "complete",
      examined_entries: examined.returned,
    },
    limitations,
  };
};

/** Decode kernel-module metadata positionally over a bounded file handle. */
export const parseKernelModuleFromHandle = async (
  source: ByteSource,
  artifact: Report["artifact"],
  input: InspectKernelModuleInput,
  signal?: AbortSignal,
  pause: () => Promise<void> = () => yieldArtifactRead(signal),
): Promise<Report> => {
  assertArtifactReadActive(signal);
  const magicProbe = await readSourceRange(source, 0, Math.min(source.size, 8));
  const compressed = moduleCompressionReport(magicProbe, artifact);
  if (compressed !== null) return compressed;
  const image = await readElfImageFromReader(
    source,
    "inspect_kernel_module",
    pause,
  );
  const facts = headerFacts(image);
  if (facts.type !== 1) return notApplicable(artifact, facts);
  const prepared = prepareKernelModule(image);
  const little = image.byte_order === "little";
  const modinfoLoc = modinfoSectionLocation(
    prepared.modinfoSection,
    source.size,
    prepared.use,
  );
  const modinfo = modinfoLoc.ready
    ? parseModinfoStored(
        await readSourceRange(
          source,
          modinfoLoc.location.offset,
          modinfoLoc.location.bytes,
        ),
        modinfoLoc.location,
        modinfoLoc.compressed,
        prepared.use,
        prepared.examined,
        input,
      )
    : modinfoLoc.result;
  const versionsLoc = versionsSectionLocation(
    prepared.versionsSection,
    source.size,
    image.bits,
    prepared.use,
  );
  const versions = versionsLoc.ready
    ? parseVersionsStored(
        await readSourceRange(
          source,
          versionsLoc.location.offset,
          versionsLoc.location.bytes,
        ),
        versionsLoc.location,
        versionsLoc.compressed,
        image.bits,
        little,
        prepared.examined,
        input.max_entries,
      )
    : versionsLoc.result;
  const extendedVersions = await parseExtendedVersions(
    source,
    prepared.extVersionNamesSection,
    prepared.extVersionCrcsSection,
    source.size,
    little,
    prepared.use,
    prepared.examined,
    input.max_entries,
    pause,
  );
  const ksymtabStrings = await parseKsymtabStrings(
    source,
    prepared.ksymtabStringsSection,
    source.size,
    prepared.use,
    prepared.examined,
    input.max_entries,
    pause,
  );
  const kcrctab = await parseKcrctabSection(
    source,
    prepared.kcrctabSection,
    "__kcrctab",
    source.size,
    little,
    prepared.use,
    prepared.examined,
    input.max_entries,
  );
  const kcrctabGpl = await parseKcrctabSection(
    source,
    prepared.kcrctabGplSection,
    "__kcrctab_gpl",
    source.size,
    little,
    prepared.use,
    prepared.examined,
    input.max_entries,
  );
  const signature = await parseSignatureFromSource(source, signal);
  return finalizeKernelModule(
    source.size,
    artifact,
    input,
    prepared,
    modinfo,
    versions,
    extendedVersions,
    ksymtabStrings,
    kcrctab,
    kcrctabGpl,
    signature,
  );
};

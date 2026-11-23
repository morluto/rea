import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../../resources/index.js";
import { allKeyed, firstKeyed, keyedBy } from "../../domain/keyedCollection.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
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
import {
  readElfImage,
  readElfImageFromReader,
} from "../../domain/native/elfImage.js";
import type { NativeByteSource } from "../../domain/native/nativeSectionDirectory.js";
import { kernelCompressionCodecAt } from "./KernelCompressionCodec.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

type ElfSection = Extract<ImageSection, { format: "elf" }>;
type Report = KernelModule;
type Limitations = string[];

const MAGIC = Buffer.from(MODULE_SIGNATURE_MAGIC, "latin1");
const MODULE_CODECS = ["gzip", "xz", "zstd"] as const;

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
  "__ksymtab entry layout is kernel-version specific and is not decoded.",
  "Only classic __versions records are decoded. Their absence does not establish the absence of CONFIG_EXTENDED_MODVERSIONS metadata in __version_ext_names and __version_ext_crcs.",
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
  this_module: null,
  ksymtab: null,
  init_text: null,
  exit_text: null,
  signature: null,
  coverage: { status: "not_applicable", examined_entries: 0 },
  limitations: [
    ...baseLimitations(),
    "Kernel module metadata is defined for ET_REL objects. This ELF type is not applicable, so .modinfo, __versions, and the signature trailer were not examined.",
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
  examined: { count: number },
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
    examined.count += 1;
    exceeds(examined.count, input.max_entries);
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
  examined: { count: number },
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
  exceeds(examined.count + count, maxEntries);
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
  examined.count += count;
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

const parseSignatureFromBuffer = (bytes: Buffer): Report["signature"] => {
  const tailLen = Math.min(
    bytes.length,
    MAGIC.length + MODULE_SIGNATURE_INFO_BYTES,
  );
  const trailer = parseSignatureTrailer(
    bytes.length,
    bytes.subarray(bytes.length - tailLen),
  );
  if (trailer.done) return trailer.signature;
  const pkcs7 = bytes.subarray(
    trailer.pkcs7Offset,
    trailer.pkcs7Offset + trailer.pkcs7Bytes,
  );
  return {
    status: "present",
    magic: trailer.magic,
    info: trailer.info,
    pkcs7: {
      location: { offset: trailer.pkcs7Offset, bytes: trailer.pkcs7Bytes },
      sha256: sha256Hex(pkcs7),
    },
    reason: null,
  };
};

const parseSignatureFromSource = async (
  source: NativeByteSource,
): Promise<Report["signature"]> => {
  const tailLen = Math.min(
    source.size,
    MAGIC.length + MODULE_SIGNATURE_INFO_BYTES,
  );
  const tailOffset = source.size - tailLen;
  const tail =
    tailLen === 0
      ? Buffer.alloc(0)
      : source.prefix !== undefined &&
          tailOffset + tailLen <= source.prefix.length
        ? source.prefix.subarray(tailOffset, tailOffset + tailLen)
        : await source.readRange(tailOffset, tailLen);
  const trailer = parseSignatureTrailer(source.size, tail);
  if (trailer.done) return trailer.signature;
  const pkcs7 =
    source.prefix !== undefined &&
    trailer.pkcs7Offset + trailer.pkcs7Bytes <= source.prefix.length
      ? source.prefix.subarray(
          trailer.pkcs7Offset,
          trailer.pkcs7Offset + trailer.pkcs7Bytes,
        )
      : await source.readRange(trailer.pkcs7Offset, trailer.pkcs7Bytes);
  return {
    status: "present",
    magic: trailer.magic,
    info: trailer.info,
    pkcs7: {
      location: { offset: trailer.pkcs7Offset, bytes: trailer.pkcs7Bytes },
      sha256: sha256Hex(pkcs7),
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

const modinfoSectionLocation = (
  section: ElfSection | undefined,
  fileLength: number,
  use: SectionUse,
):
  | { readonly ready: false; readonly result: NonNullable<Report["modinfo"]> }
  | {
      readonly ready: true;
      readonly location: { offset: number; bytes: number };
      readonly compressed: boolean;
    } => {
  if (section === undefined)
    return {
      ready: false,
      result: {
        status: use.namesComplete ? "absent" : "unknown",
        location: null,
        sha256: null,
        entries: [],
        reason: null,
      },
    };
  const location = locationOf(section);
  if (section.type === 8 || location === null || !inFile(section, fileLength))
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
  return { ready: true, location, compressed: section.compressed };
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
      readonly location: { offset: number; bytes: number };
      readonly compressed: boolean;
    } => {
  const layout =
    bits === 64 ? "elf64_unsigned_long_name56" : "elf32_unsigned_long_name60";
  const entryBytes = KERNEL_MODULE_VERSION_ENTRY_BYTES;
  if (section === undefined)
    return {
      ready: false,
      result: {
        status: use.namesComplete ? "absent" : "unknown",
        layout,
        entry_bytes: entryBytes,
        location: null,
        sha256: null,
        entries: [],
        reason: null,
      },
    };
  const location = locationOf(section);
  if (section.type === 8 || location === null || !inFile(section, fileLength))
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
  return { ready: true, location, compressed: section.compressed };
};

const readSourceRange = async (
  source: NativeByteSource,
  offset: number,
  length: number,
): Promise<Buffer> =>
  length === 0
    ? Buffer.alloc(0)
    : source.prefix !== undefined && offset + length <= source.prefix.length
      ? source.prefix.subarray(offset, offset + length)
      : source.readRange(offset, length);

interface KernelModulePrepared {
  readonly facts: ReturnType<typeof headerFacts>;
  readonly sections: readonly ElfSection[];
  readonly namesComplete: boolean;
  readonly limitations: Limitations;
  readonly use: SectionUse;
  readonly examined: { count: number };
  readonly duplicateSections: () => boolean;
  readonly modinfoSection: ElfSection | undefined;
  readonly versionsSection: ElfSection | undefined;
  readonly firstNamedSection: (name: string) => ElfSection | undefined;
}

const prepareKernelModule = (
  image: ReturnType<typeof readElfImage>,
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
  const examined = { count: 0 };
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
  examined.count += ksymtab.length;
  exceeds(examined.count, input.max_entries);
  if (!namesComplete)
    limitations.push(
      "Section names are incomplete, so a missing .modinfo, __versions, this_module, __ksymtab, .init.text, or .exit.text section is unknown rather than absent.",
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
  const sectionIncomplete = (
    section: NonNullable<Report["modinfo"]> | NonNullable<Report["versions"]>,
  ) =>
    (section.status !== "present" && section.status !== "absent") ||
    section.entries.some((entry) => entry.status !== "observed");
  const coveragePartial =
    !namesComplete ||
    prepared.duplicateSections() ||
    unbacked > 0 ||
    ksymtab.some((section) => section.reason !== null) ||
    sectionIncomplete(modinfo) ||
    modinfo.entries.some((entry) => entry.omitted_fields.length > 0) ||
    sectionIncomplete(versions) ||
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
    this_module: {
      status: modulePresence.status,
      location: modulePresence.location,
      layout: "unknown",
    },
    ksymtab: {
      status: namesComplete ? "observed" : "unknown",
      sections: ksymtab,
    },
    init_text: initText,
    exit_text: exitText,
    signature,
    coverage: {
      status: coveragePartial ? "partial" : "complete",
      examined_entries: examined.count,
    },
    limitations,
  };
};

/** Decode kernel-module metadata from an admitted in-memory ELF image. */
const parseKernelModuleImage = (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectKernelModuleInput,
  image: ReturnType<typeof readElfImage>,
): Report => {
  const facts = headerFacts(image);
  if (facts.type !== 1) return notApplicable(artifact, facts);
  const prepared = prepareKernelModule(image);
  const modinfoLoc = modinfoSectionLocation(
    prepared.modinfoSection,
    bytes.length,
    prepared.use,
  );
  const modinfo = modinfoLoc.ready
    ? parseModinfoStored(
        bytes.subarray(
          modinfoLoc.location.offset,
          modinfoLoc.location.offset + modinfoLoc.location.bytes,
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
    bytes.length,
    image.bits,
    prepared.use,
  );
  const versions = versionsLoc.ready
    ? parseVersionsStored(
        bytes.subarray(
          versionsLoc.location.offset,
          versionsLoc.location.offset + versionsLoc.location.bytes,
        ),
        versionsLoc.location,
        versionsLoc.compressed,
        image.bits,
        image.byte_order === "little",
        prepared.examined,
        input.max_entries,
      )
    : versionsLoc.result;
  return finalizeKernelModule(
    bytes.length,
    artifact,
    input,
    prepared,
    modinfo,
    versions,
    parseSignatureFromBuffer(bytes),
  );
};

export const parseKernelModule = (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectKernelModuleInput,
): Report =>
  moduleCompressionReport(bytes, artifact) ??
  parseKernelModuleImage(
    bytes,
    artifact,
    input,
    readElfImage(bytes, "inspect_kernel_module"),
  );

/** Decode kernel-module metadata positionally over a bounded file handle. */
export const parseKernelModuleFromHandle = async (
  source: NativeByteSource,
  artifact: Report["artifact"],
  input: InspectKernelModuleInput,
  signal?: AbortSignal,
): Promise<Report> => {
  assertArtifactReadActive(signal);
  const magicProbe = await readSourceRange(source, 0, Math.min(source.size, 8));
  const compressed = moduleCompressionReport(magicProbe, artifact);
  if (compressed !== null) return compressed;
  const image = await readElfImageFromReader(
    source,
    "inspect_kernel_module",
    () => yieldArtifactRead(signal),
  );
  const facts = headerFacts(image);
  if (facts.type !== 1) return notApplicable(artifact, facts);
  const prepared = prepareKernelModule(image);
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
        image.byte_order === "little",
        prepared.examined,
        input.max_entries,
      )
    : versionsLoc.result;
  const signature = await parseSignatureFromSource(source);
  return finalizeKernelModule(
    source.size,
    artifact,
    input,
    prepared,
    modinfo,
    versions,
    signature,
  );
};

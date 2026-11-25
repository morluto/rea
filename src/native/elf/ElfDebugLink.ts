import { crc32 } from "node:zlib";

import { isParseLimit } from "../../domain/parseFailureAnalysisError.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../../resources/index.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import {
  hasElfMagic,
  BinaryReader,
  type ImageSection,
  BinaryResourceFailure,
} from "../../domain/binaryContainer.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  zstandardFrameAllowanceCause,
  type ZstandardFrameAllowanceError,
} from "../../domain/compression/zstandardFrameAllowance.js";
import {
  debugFileNameIsSingleSegment,
  deriveDebugFileLookupPaths,
  ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_LIMITATIONS,
  ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
  ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION,
  ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
  MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES,
  MAX_ELF_DEBUG_LINK_NAME_BYTES,
  type ElfDebugLink,
  type ElfDebugLinkLimitationCode,
  type InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import {
  elfSectionFitsFile,
  elfSectionLocation,
  readElfImage,
  readElfImageCooperative,
  readElfImageFromReader,
} from "../../domain/native/elfImage.js";
import {
  readElfBuildIds,
  readElfBuildIdsCooperative,
  readElfBuildIdsFromHandle,
} from "./ElfNoteParser.js";
import type { ZstandardFramePause } from "../../domain/compression/zstandardExactFrame.js";
import {
  sharedElfSectionNameDecoder,
  type CooperativeElfSectionNameDecoder,
  type ElfSectionNameDecodeRequest,
} from "../../domain/native/elfSectionNameTable.js";

import { err, ok, type Result } from "../../domain/result.js";
import type {
  ByteSource,
  PrefixedByteSource,
} from "../../domain/byteSource.js";

type PreparedCandidateImage = Result<ReturnType<typeof readElfImage>, unknown>;
type PreparedNotes = Result<ReturnType<typeof readElfBuildIds>, unknown>;

type ElfSection = Extract<ImageSection, { format: "elf" }>;
type Report = ElfDebugLink;
type SectionStatus = Report["debuglink"]["status"];
type BuildId = Report["build_id"];
type Limitations = string[];

const DEBUG_SECTION_NAMES = [
  ".gnu_debuglink",
  ".gnu_debugaltlink",
  ".gnu_debugdata",
] as const;
const DEBUGLINK_CRC_BYTES = 4;
const LINK_NAME_SCAN_CHUNK_BYTES = 1024 * 1024;
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

const untrustedName = (
  text: string,
): NonNullable<Report["debuglink"]["filename"]> => ({
  text,
  encoding: "latin1",
  trust: "observed-untrusted",
});

const crc32Hex = (value: number): string =>
  (value >>> 0).toString(16).padStart(8, "0");

/** Continue a GNU debuglink CRC32 over the next streamed chunk. */
export const continueGnuDebuglinkCrc32 = (
  value: number,
  chunk: Buffer,
): number => crc32(chunk, value) >>> 0;

const isRethrownBudget = (cause: unknown): boolean =>
  isParseLimit(cause, "elf") ||
  isParseLimit(cause, "elf-notes") ||
  cause instanceof BinaryResourceFailure;

interface LocatedSection {
  readonly status: SectionStatus;
  readonly location: { offset: number; bytes: number } | null;
  readonly reason: "not_file_backed" | "compressed" | "duplicate" | null;
}

const locateSection = (
  fileLength: number,
  found: readonly ElfSection[],
  namesComplete: boolean,
): LocatedSection => {
  const section = found[0];
  if (section === undefined)
    return {
      status: namesComplete ? "absent" : "unknown",
      location: null,
      reason: null,
    };
  if (found.length > 1)
    return {
      status: "malformed",
      location: null,
      reason: "duplicate",
    };
  const location = elfSectionLocation(section);
  if (
    section.type === 8 ||
    location === null ||
    !elfSectionFitsFile(section, fileLength)
  )
    return {
      status: "malformed",
      location: null,
      reason: "not_file_backed",
    };
  if (section.compressed)
    return {
      status: "unsupported",
      location,
      reason: "compressed",
    };
  return {
    status: "present",
    location,
    reason: null,
  };
};

const readSourceSlice = async (
  source: ByteSource,
  offset: number,
  length: number,
): Promise<Buffer> =>
  length === 0
    ? Buffer.alloc(0)
    : source.prefix !== undefined && offset + length <= source.prefix.length
      ? source.prefix.subarray(offset, offset + length)
      : source.readRange(offset, length);

const readLinkName = async (
  source: ByteSource,
  location: NonNullable<LocatedSection["location"]>,
  tailBytes: number,
): Promise<{ readonly prefix: Buffer; readonly nul: number }> => {
  const prefixLength = Math.min(
    location.bytes,
    MAX_ELF_DEBUG_LINK_NAME_BYTES + 1 + tailBytes,
  );
  const prefix = await readSourceSlice(source, location.offset, prefixLength);
  const found = prefix.indexOf(0);
  if (found >= 0 || prefix.length < prefixLength) return { prefix, nul: found };

  // An overlong name can still have a usable CRC or build ID. Find its
  // actual terminator without retaining the unreportable name.
  for (let offset = prefix.length; offset < location.bytes;) {
    const length = Math.min(
      LINK_NAME_SCAN_CHUNK_BYTES,
      location.bytes - offset,
    );
    const chunk = await readSourceSlice(
      source,
      location.offset + offset,
      length,
    );
    const nul = chunk.indexOf(0);
    if (nul >= 0) return { prefix, nul: offset + nul };
    if (chunk.length < length) break;
    offset += length;
  }
  return { prefix, nul: -1 };
};

const readLinkTail = (
  source: ByteSource,
  prefix: Buffer,
  sectionOffset: number,
  offset: number,
  length: number,
): Promise<Buffer> =>
  offset + length <= prefix.length
    ? Promise.resolve(prefix.subarray(offset, offset + length))
    : readSourceSlice(source, sectionOffset + offset, length);

const closedDebuglink = (
  status: SectionStatus,
  reason: Report["debuglink"]["reason"],
  location: Report["debuglink"]["location"] = null,
): Report["debuglink"] => ({
  status,
  location,
  filename: null,
  crc32_hex: null,
  reason,
});

const parseDebuglink = async (
  source: ByteSource,
  located: LocatedSection,
  little: boolean,
): Promise<Report["debuglink"]> => {
  if (located.reason === "duplicate")
    return closedDebuglink("malformed", "debuglink_duplicate_section");
  if (located.reason === "not_file_backed")
    return closedDebuglink("malformed", "debuglink_not_file_backed");
  if (located.reason === "compressed")
    return closedDebuglink(
      "unsupported",
      "debuglink_section_compressed",
      located.location,
    );
  const { location } = located;
  if (located.status !== "present" || location === null)
    return closedDebuglink(located.status, null);
  const { prefix, nul } = await readLinkName(
    source,
    location,
    3 + DEBUGLINK_CRC_BYTES, // At most three bytes of alignment before the CRC.
  );
  if (nul < 0)
    return closedDebuglink(
      "malformed",
      "debuglink_unterminated_name",
      location,
    );
  const crcOffset = Math.ceil((nul + 1) / 4) * 4;
  if (crcOffset + DEBUGLINK_CRC_BYTES > location.bytes)
    return closedDebuglink("malformed", "debuglink_truncated", location);
  const crcBytes = await readLinkTail(
    source,
    prefix,
    location.offset,
    crcOffset,
    DEBUGLINK_CRC_BYTES,
  );
  if (crcBytes.length !== DEBUGLINK_CRC_BYTES)
    return closedDebuglink("malformed", "debuglink_truncated", location);
  const crc = new BinaryReader(crcBytes, little, "elf").u32(0);
  let reason: Report["debuglink"]["reason"] = null;
  if (nul === 0) reason = "debuglink_empty_name";
  else if (nul > MAX_ELF_DEBUG_LINK_NAME_BYTES)
    reason = "debuglink_name_exceeds_limit";
  return {
    status: reason === null ? "present" : "malformed",
    location,
    filename:
      reason === null ? untrustedName(prefix.toString("latin1", 0, nul)) : null,
    crc32_hex: crc32Hex(crc),
    reason,
  };
};

const closedAlt = (
  status: SectionStatus,
  reason: Report["debugaltlink"]["reason"],
  location: Report["debugaltlink"]["location"] = null,
): Report["debugaltlink"] => ({
  status,
  location,
  filename: null,
  build_id_hex: null,
  reason,
});

const parseDebugaltlink = async (
  source: ByteSource,
  located: LocatedSection,
): Promise<Report["debugaltlink"]> => {
  if (located.reason === "duplicate")
    return closedAlt("malformed", "debugaltlink_duplicate_section");
  if (located.reason === "not_file_backed")
    return closedAlt("malformed", "debugaltlink_not_file_backed");
  if (located.reason === "compressed")
    return closedAlt(
      "unsupported",
      "debugaltlink_section_compressed",
      located.location,
    );
  const { location } = located;
  if (located.status !== "present" || location === null)
    return closedAlt(located.status, null);
  const { prefix, nul } = await readLinkName(
    source,
    location,
    MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES,
  );
  if (nul < 0)
    return closedAlt("malformed", "debugaltlink_unterminated_name", location);
  const buildBytes = location.bytes - (nul + 1);
  const nameTooLong = nul > MAX_ELF_DEBUG_LINK_NAME_BYTES;
  const buildTooLong = buildBytes > MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES;
  const filename =
    nul > 0 && !nameTooLong
      ? untrustedName(prefix.toString("latin1", 0, nul))
      : null;
  const buildHex =
    buildBytes === 0 || buildTooLong
      ? null
      : (
          await readLinkTail(
            source,
            prefix,
            location.offset,
            nul + 1,
            buildBytes,
          )
        ).toString("hex");
  let reason: Report["debugaltlink"]["reason"] = null;
  if (buildBytes === 0) reason = "debugaltlink_missing_build_id";
  else if (nul === 0) reason = "debugaltlink_empty_name";
  else if (nameTooLong) reason = "debugaltlink_name_exceeds_limit";
  else if (buildTooLong) reason = "debugaltlink_build_id_exceeds_limit";
  return {
    status: reason === null ? "present" : "malformed",
    location,
    filename,
    build_id_hex: buildHex,
    reason,
  };
};

const parseDebugdata = async (
  source: ByteSource,
  located: LocatedSection,
): Promise<Report["debugdata"]> => {
  if (located.reason === "duplicate")
    return {
      status: "malformed",
      location: null,
      xz_magic: null,
      reason: "debugdata_duplicate_section",
    };
  if (located.reason === "not_file_backed")
    return {
      status: "malformed",
      location: null,
      xz_magic: null,
      reason: "debugdata_not_file_backed",
    };
  if (located.reason === "compressed")
    return {
      status: "unsupported",
      location: located.location,
      xz_magic: null,
      reason: "debugdata_section_compressed",
    };
  const { location } = located;
  if (located.status !== "present" || location === null)
    return {
      status: located.status,
      location: null,
      xz_magic: null,
      reason: null,
    };
  const magicBytes = await readSourceSlice(
    source,
    location.offset,
    Math.min(location.bytes, XZ_MAGIC.length),
  );
  if (magicBytes.length < XZ_MAGIC.length)
    return {
      status: "malformed",
      location,
      xz_magic: false,
      reason: "debugdata_truncated",
    };
  const magic = magicBytes.equals(XZ_MAGIC);
  return {
    status: magic ? "present" : "malformed",
    location,
    xz_magic: magic,
    reason: magic ? null : "debugdata_not_xz",
  };
};

interface ObservedBuildId {
  readonly buildId: BuildId;
  readonly limitation: string | null;
}

const unknownBuildId = (
  reason: "note_tables_malformed" | "note_tables_unsupported",
  limitation: string | null,
): ObservedBuildId => ({
  buildId: { status: "unknown", hex: null, ids: [], sources: [], reason },
  limitation,
});

const observeBuildId = (
  bytes: Buffer,
  input: InspectElfDebugLinkInput,
  preparedNotes?: PreparedNotes,
): ObservedBuildId => {
  let notes: ReturnType<typeof readElfBuildIds>;
  try {
    if (preparedNotes !== undefined && !preparedNotes.ok)
      throw preparedNotes.error;
    notes =
      preparedNotes?.value ??
      readElfBuildIds(bytes, input, MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES);
  } catch (cause) {
    if (
      isRethrownBudget(cause) ||
      zstandardFrameAllowanceCause(cause) !== undefined
    )
      throw cause;
    if (cause instanceof ParseFailureError && cause.kind !== "limit")
      return unknownBuildId(
        cause.kind === "unsupported"
          ? "note_tables_unsupported"
          : "note_tables_malformed",
        `ELF note tables could not be decoded: ${cause.message}`,
      );
    throw cause;
  }
  const { sources, oversized, unreadableStorage } = notes;
  const ids = [...new Set(sources.map(({ hex }) => hex))];
  // Retain readable ids and their note locations when identity is incomplete.
  if (unreadableStorage !== null || oversized)
    return {
      buildId: {
        status: "unknown",
        hex: null,
        ids,
        sources,
        reason:
          unreadableStorage === null
            ? "build_id_exceeds_limit"
            : "note_tables_unsupported",
      },
      limitation:
        unreadableStorage ??
        "A GNU build-id exceeds 256 bytes and was not copied.",
    };
  if (ids.length === 0)
    return {
      buildId: {
        status: "absent",
        hex: null,
        ids: [],
        sources: [],
        reason: null,
      },
      limitation: null,
    };
  if (ids.length > 1)
    return {
      buildId: {
        status: "conflict",
        hex: null,
        ids,
        sources,
        reason: "multiple_build_ids",
      },
      limitation: ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
    };
  const hex = ids[0] ?? null;
  return {
    buildId: { status: "observed", hex, ids, sources, reason: null },
    limitation: null,
  };
};

const sectionsNamed = (
  sections: readonly ElfSection[],
  name: string,
): readonly ElfSection[] => sections.filter((section) => section.name === name);

const ELF_DEBUG_LINK_OPERATION = "inspect_elf_debug_link";

const finalizeElfDebugLinkReport = (
  image: ReturnType<typeof readElfImage>,
  sections: readonly ElfSection[],
  namesComplete: boolean,
  artifact: Report["artifact"],
  debuglink: Report["debuglink"],
  debugaltlink: Report["debugaltlink"],
  debugdata: Report["debugdata"],
  observed: ObservedBuildId,
): Report => {
  const limitationCodes: ElfDebugLinkLimitationCode[] = ["standing_caveats"];
  const limitations: Limitations = [...ELF_DEBUG_LINK_LIMITATIONS];
  if (image.section_names_limitation !== undefined)
    limitations.push(image.section_names_limitation);
  if (observed.limitation !== null) limitations.push(observed.limitation);
  if (observed.buildId.status === "conflict")
    limitationCodes.push("multiple_build_ids");
  const filename = debuglink.filename?.text ?? null;
  if (filename !== null && !debugFileNameIsSingleSegment(filename)) {
    limitationCodes.push("name_not_single_segment");
    limitations.push(ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION);
  }
  const lookup_paths = deriveDebugFileLookupPaths({
    binaryPath: artifact.path,
    debuglinkName: filename,
    buildIdHex:
      observed.buildId.status === "observed" ? observed.buildId.hex : null,
    altBuildIdHex: debugaltlink.build_id_hex,
  });
  const examined_sections = sections.filter(
    (section) =>
      section.name !== null &&
      DEBUG_SECTION_NAMES.some((name) => name === section.name),
  ).length;
  const coverageIncomplete =
    !namesComplete || observed.buildId.status === "unknown";
  return {
    artifact,
    format: image.bits === 64 ? "elf64" : "elf32",
    byte_order: image.byte_order,
    machine: image.elf.machine,
    type: image.elf.type,
    type_name: elfObjectTypeName(image.elf.type),
    debuglink,
    debugaltlink,
    debugdata,
    build_id: observed.buildId,
    lookup_paths,
    candidate: null,
    verification: null,
    coverage: {
      status: coverageIncomplete ? "partial" : "complete",
      examined_sections,
    },
    limitation_codes: limitationCodes,
    limitations,
  };
};

interface CandidateIdentity {
  readonly notElf: boolean;
  readonly elfMalformed: boolean;
  readonly buildId: BuildId;
  readonly candidateHex: string | null;
}

const candidateSections = (
  image: ReturnType<typeof readElfImage> | null,
): Pick<NonNullable<Report["candidate"]>, "debug_info" | "symtab"> => {
  if (image === null) return { debug_info: "unknown", symtab: "unknown" };
  const sections = image.sections.filter(
    (section): section is ElfSection => section.format === "elf",
  );
  const namesComplete =
    image.section_names_limitation === undefined &&
    sections.every((section) => section.name !== null);
  const status = (
    names: readonly string[],
  ): "present" | "absent" | "unknown" => {
    const named = sections.filter((section) =>
      names.some((name) => name === section.name),
    );
    // A declaration whose range is not inside the file does not supply that
    // content, so its presence stays unknown rather than present.
    if (named.some((section) => section.file_backed)) return "present";
    if (named.length > 0) return "unknown";
    return namesComplete ? "absent" : "unknown";
  };
  // `.zdebug_info` is the zlib-gnu name for compressed `.debug_info`.
  return {
    debug_info: status([".debug_info", ".zdebug_info"]),
    symtab: status([".symtab"]),
  };
};

const readCandidateIdentity = (
  content: Buffer,
  totalBytes: number,
  input: InspectElfDebugLinkInput,
  preparedImage?: PreparedCandidateImage,
  preparedNotes?: PreparedNotes,
): {
  readonly format: NonNullable<Report["candidate"]>["format"];
  readonly byte_order: NonNullable<Report["candidate"]>["byte_order"];
  readonly sections: Pick<
    NonNullable<Report["candidate"]>,
    "debug_info" | "symtab"
  >;
  readonly identity: CandidateIdentity;
  readonly budgetExceeded: boolean;
  readonly frameAllowance?: ZstandardFrameAllowanceError;
} => {
  const complete = content.length === totalBytes;
  const header = readElfFixedHeader(content, totalBytes);
  if (!header.ok && hasElfMagic(content))
    // ELF magic with an unusable fixed header is a malformed ELF, not another format.
    return {
      format: null,
      byte_order: null,
      sections: { debug_info: "unknown", symtab: "unknown" },
      identity: {
        notElf: false,
        elfMalformed: true,
        buildId: {
          status: "unknown",
          hex: null,
          ids: [],
          sources: [],
          reason: null,
        },
        candidateHex: null,
      },
      budgetExceeded: false,
    };
  if (!header.ok)
    return {
      format: null,
      byte_order: null,
      sections: { debug_info: "not_elf", symtab: "not_elf" },
      identity: {
        notElf: true,
        elfMalformed: false,
        buildId: {
          status: "absent",
          hex: null,
          ids: [],
          sources: [],
          reason: null,
        },
        candidateHex: null,
      },
      budgetExceeded: false,
    };
  if (!complete)
    // Only a bounded prefix was retained, so sections and notes stay unread.
    return {
      format: header.value.elfClass === 64 ? "elf64" : "elf32",
      byte_order: header.value.byteOrder,
      sections: { debug_info: "unknown", symtab: "unknown" },
      identity: {
        notElf: false,
        elfMalformed: false,
        buildId: {
          status: "unknown",
          hex: null,
          ids: [],
          sources: [],
          reason: null,
        },
        candidateHex: null,
      },
      budgetExceeded: false,
    };
  let image: ReturnType<typeof readElfImage> | null = null;
  let imageMalformed = false;
  let imageBudgetExceeded = false;
  let frameAllowance: ZstandardFrameAllowanceError | undefined;
  try {
    if (preparedImage !== undefined && !preparedImage.ok)
      throw preparedImage.error;
    image =
      preparedImage?.value ??
      readElfImage(content, ELF_DEBUG_LINK_OPERATION, input.max_file_bytes);
  } catch (cause) {
    frameAllowance = zstandardFrameAllowanceCause(cause);
    if (frameAllowance === undefined) {
      if (cause instanceof AnalysisError) throw cause;
      if (isRethrownBudget(cause)) imageBudgetExceeded = true;
      else imageMalformed = true;
    }
  }
  // The candidate may lose named evidence without losing its file identity
  // or CRC. If its section names already exceeded the frame allowance, the
  // note reader cannot decode that same table either.
  let observed: ObservedBuildId | null = null;
  if (frameAllowance === undefined) {
    try {
      observed = observeBuildId(content, input, preparedNotes);
    } catch (cause) {
      frameAllowance = zstandardFrameAllowanceCause(cause);
      if (frameAllowance === undefined && !isRethrownBudget(cause)) throw cause;
    }
  }
  const buildId: BuildId = observed?.buildId ?? {
    status: "unknown",
    hex: null,
    ids: [],
    sources: [],
    reason: null,
  };
  return {
    format: header.value.elfClass === 64 ? "elf64" : "elf32",
    byte_order: header.value.byteOrder,
    sections: candidateSections(image),
    identity: {
      notElf: false,
      elfMalformed:
        imageMalformed && observed !== null && buildId.status === "unknown",
      buildId,
      candidateHex: buildId.status === "observed" ? buildId.hex : null,
    },
    budgetExceeded:
      imageBudgetExceeded ||
      (frameAllowance === undefined && observed === null),
    ...(frameAllowance === undefined ? {} : { frameAllowance }),
  };
};

const crcCheck = (
  expected: string | null,
  candidateCrc32: number,
): NonNullable<Report["verification"]>["crc32"] => {
  const observed = crc32Hex(candidateCrc32);
  if (expected === null)
    return {
      status: "unavailable",
      expected_hex: null,
      observed_hex: observed,
      reason: "debuglink_crc_absent",
    };
  return {
    status: expected === observed ? "match" : "mismatch",
    expected_hex: expected,
    observed_hex: observed,
    reason: null,
  };
};

const buildIdCheck = (
  binary: BuildId,
  identity: CandidateIdentity,
): NonNullable<Report["verification"]>["build_id"] => {
  const candidateHex = identity.candidateHex;
  if (binary.status === "unknown")
    return {
      status: "unavailable",
      binary_hex: null,
      candidate_hex: candidateHex,
      reason: "binary_build_id_unknown",
    };
  if (binary.status === "conflict")
    return {
      status: "unavailable",
      binary_hex: null,
      candidate_hex: candidateHex,
      reason: "binary_build_id_conflict",
    };
  if (binary.status !== "observed" || binary.hex === null)
    return {
      status: "unavailable",
      binary_hex: null,
      candidate_hex: candidateHex,
      reason: "binary_build_id_absent",
    };
  const binaryHex = binary.hex;
  if (identity.notElf)
    return {
      status: "unavailable",
      binary_hex: binaryHex,
      candidate_hex: null,
      reason: "candidate_not_elf",
    };
  if (identity.elfMalformed)
    return {
      status: "unavailable",
      binary_hex: binaryHex,
      candidate_hex: null,
      reason: "candidate_elf_malformed",
    };
  if (identity.buildId.status === "unknown")
    return {
      status: "unavailable",
      binary_hex: binaryHex,
      candidate_hex: null,
      reason: "candidate_build_id_unknown",
    };
  if (identity.buildId.status === "conflict")
    return {
      status: "unavailable",
      binary_hex: binaryHex,
      candidate_hex: null,
      reason: "candidate_build_id_conflict",
    };
  if (identity.buildId.status !== "observed" || candidateHex === null)
    return {
      status: "unavailable",
      binary_hex: binaryHex,
      candidate_hex: null,
      reason: "candidate_build_id_absent",
    };
  return {
    status: binaryHex === candidateHex ? "match" : "mismatch",
    binary_hex: binaryHex,
    candidate_hex: candidateHex,
    reason: null,
  };
};

const verificationOf = (
  crc: NonNullable<Report["verification"]>["crc32"],
  build: NonNullable<Report["verification"]>["build_id"],
): NonNullable<Report["verification"]> => {
  const crcMismatch = crc.status === "mismatch";
  const idMismatch = build.status === "mismatch";
  if (crcMismatch || idMismatch) {
    const reason =
      crcMismatch && idMismatch
        ? "crc32_and_build_id_mismatch"
        : crcMismatch
          ? "crc32_mismatch"
          : "build_id_mismatch";
    return { status: "does_not_match", reason, crc32: crc, build_id: build };
  }
  if (crc.status === "match" || build.status === "match")
    return { status: "matches", reason: null, crc32: crc, build_id: build };
  return {
    status: "cannot_verify",
    reason: "no_comparable_identity",
    crc32: crc,
    build_id: build,
  };
};

/** One streamed candidate: whole-file identity plus a bounded retained prefix. */
export interface ElfDebugCandidateFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** GNU debuglink CRC32 over all `bytes`, accumulated while streaming. */
  readonly crc32: number;
  /** The whole file when it fit the parse budget, otherwise its ELF header. */
  readonly prefix: Buffer;
}

/** Compare one caller-selected file with an already decoded debug-link report. */
export const verifyElfDebugCandidate = (
  report: Report,
  candidate: ElfDebugCandidateFile,
  input: InspectElfDebugLinkInput,
  preparedImage?: PreparedCandidateImage,
  preparedNotes?: PreparedNotes,
): Report => {
  const read = readCandidateIdentity(
    candidate.prefix,
    candidate.bytes,
    input,
    preparedImage,
    preparedNotes,
  );
  const crc = crcCheck(report.debuglink.crc32_hex, candidate.crc32);
  const build = buildIdCheck(report.build_id, read.identity);
  const verification = verificationOf(crc, build);
  const limitationCodes: ElfDebugLinkLimitationCode[] = [
    ...report.limitation_codes,
  ];
  const limitations = [...report.limitations];
  if (candidate.prefix.length !== candidate.bytes) {
    limitationCodes.push("candidate_prefix_only");
    limitations.push(ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION);
  }
  if (read.budgetExceeded) {
    limitationCodes.push("candidate_budget_exceeded");
    limitations.push(ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION);
  }
  if (read.frameAllowance !== undefined)
    limitations.push(
      `Candidate ELF section names could not be decoded because ${read.frameAllowance.failure.detail}.`,
    );
  if (
    verification.status === "matches" &&
    (crc.status === "unavailable" || build.status === "unavailable")
  ) {
    limitationCodes.push("unavailable_check");
    limitations.push(ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION);
  }
  if (verification.status === "cannot_verify") {
    limitationCodes.push("cannot_verify");
    limitations.push(ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION);
  }
  return {
    ...report,
    candidate: {
      path: candidate.path,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      format: read.format,
      byte_order: read.byte_order,
      ...read.sections,
    },
    verification,
    limitation_codes: limitationCodes,
    limitations,
  };
};

const debugLinkPause = (signal?: AbortSignal) => () =>
  yieldArtifactRead(signal);

const prepareBuildIdNotes = async (
  bytes: Buffer,
  input: InspectElfDebugLinkInput,
  decode: CooperativeElfSectionNameDecoder,
  signal: AbortSignal | undefined,
): Promise<PreparedNotes> => {
  assertArtifactReadActive(signal);
  try {
    return ok(
      await readElfBuildIdsCooperative(
        bytes,
        input,
        MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES,
        decode,
      ),
    );
  } catch (cause) {
    assertArtifactReadActive(signal);
    return err(cause);
  }
};

/** Decode separate-debug linkage positionally over a bounded file handle. */
export const parseElfDebugLinkFromHandle = async (
  source: PrefixedByteSource,
  artifact: Report["artifact"],
  input: InspectElfDebugLinkInput,
  signal?: AbortSignal,
): Promise<Report> => {
  const pause = debugLinkPause(signal);
  const decode = sharedElfSectionNameDecoder(pause);
  let sectionNames: ElfSectionNameDecodeRequest | undefined;
  const image = await readElfImageFromReader(
    source,
    ELF_DEBUG_LINK_OPERATION,
    pause,
    input.max_file_bytes,
    (request) => {
      sectionNames = request;
      return decode(request);
    },
  );
  // Both readers borrow the same stable file. Reuse only the exact extent
  // admitted by the image reader so the decoder can share its result.
  const noteSource: PrefixedByteSource = {
    size: source.size,
    prefix: source.prefix,
    readRange: (offset, length) =>
      sectionNames?.fileOffset === offset && sectionNames.raw.length === length
        ? Promise.resolve(sectionNames.raw)
        : source.readRange(offset, length),
  };
  let notes: PreparedNotes;
  assertArtifactReadActive(signal);
  try {
    notes = ok(
      await readElfBuildIdsFromHandle(
        noteSource,
        input,
        MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES,
        decode,
      ),
    );
  } catch (cause) {
    assertArtifactReadActive(signal);
    notes = err(cause);
  }
  assertArtifactReadActive(signal);
  const sections = image.sections.filter(
    (section): section is ElfSection => section.format === "elf",
  );
  const namesComplete =
    image.section_names_limitation === undefined &&
    sections.every((section) => section.name !== null);
  const little = image.byte_order === "little";
  const debuglink = await parseDebuglink(
    source,
    locateSection(
      source.size,
      sectionsNamed(sections, ".gnu_debuglink"),
      namesComplete,
    ),
    little,
  );
  const debugaltlink = await parseDebugaltlink(
    source,
    locateSection(
      source.size,
      sectionsNamed(sections, ".gnu_debugaltlink"),
      namesComplete,
    ),
  );
  const debugdata = await parseDebugdata(
    source,
    locateSection(
      source.size,
      sectionsNamed(sections, ".gnu_debugdata"),
      namesComplete,
    ),
  );
  const observed = observeBuildId(Buffer.alloc(0), input, notes);
  return finalizeElfDebugLinkReport(
    image,
    sections,
    namesComplete,
    artifact,
    debuglink,
    debugaltlink,
    debugdata,
    observed,
  );
};

/** Same comparison as {@link verifyElfDebugCandidate}. Section names yield for `signal`. */
export const verifyElfDebugCandidateCooperative = async (
  report: Report,
  candidate: ElfDebugCandidateFile,
  input: InspectElfDebugLinkInput,
  signal?: AbortSignal,
): Promise<Report> => {
  assertArtifactReadActive(signal);
  if (
    candidate.prefix.length !== candidate.bytes ||
    !hasElfMagic(candidate.prefix)
  )
    return verifyElfDebugCandidate(report, candidate, input);
  const pause = debugLinkPause(signal);
  const decode = sharedElfSectionNameDecoder(pause);
  let preparedImage: PreparedCandidateImage;
  try {
    preparedImage = ok(
      await readElfImageCooperative(
        candidate.prefix,
        ELF_DEBUG_LINK_OPERATION,
        pause,
        input.max_file_bytes,
        decode,
      ),
    );
  } catch (cause) {
    assertArtifactReadActive(signal);
    preparedImage = err(cause);
  }
  // A typed image error already determines the candidate outcome.
  if (
    !preparedImage.ok &&
    (preparedImage.error instanceof AnalysisError ||
      zstandardFrameAllowanceCause(preparedImage.error) !== undefined)
  )
    return verifyElfDebugCandidate(report, candidate, input, preparedImage);
  const notes = await prepareBuildIdNotes(
    candidate.prefix,
    input,
    decode,
    signal,
  );
  assertArtifactReadActive(signal);
  return verifyElfDebugCandidate(
    report,
    candidate,
    input,
    preparedImage,
    notes,
  );
};

/** Keep the decoded image linkage when the selected candidate cannot be read. */
export const unreadableElfDebugCandidate = (report: Report): Report => ({
  ...report,
  candidate: null,
  verification: {
    status: "cannot_verify",
    reason: "candidate_unreadable",
    crc32: {
      status: "unavailable",
      expected_hex: report.debuglink.crc32_hex,
      observed_hex: null,
      reason: "candidate_unreadable",
    },
    build_id: {
      status: "unavailable",
      binary_hex:
        report.build_id.status === "observed" ? report.build_id.hex : null,
      candidate_hex: null,
      reason: "candidate_unreadable",
    },
  },
  limitation_codes: [
    ...report.limitation_codes,
    "candidate_unreadable",
    "cannot_verify",
  ],
  limitations: [
    ...report.limitations,
    ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
    ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ],
});

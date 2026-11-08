import { crc32 } from "node:zlib";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
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
  type InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import type { ImageSection } from "../metadata/BinaryContainer.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { readElfImage } from "../metadata/ElfImage.js";
import {
  ElfNoteSectionNameBudgetFailure,
  parseElfNotes,
} from "./ElfNoteParser.js";

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
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const CRC_CHUNK = 65536;

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

const untrustedName = (
  text: string,
): NonNullable<Report["debuglink"]["filename"]> => ({
  text,
  encoding: "latin1",
  trust: "observed-untrusted",
});

const crc32Hex = (value: number): string =>
  (value >>> 0).toString(16).padStart(8, "0");

/** GNU debuglink CRC32 of one bounded buffer. Continuation matches one-shot. */
export const gnuDebuglinkCrc32 = (bytes: Buffer): number => {
  let value = 0;
  for (let offset = 0; offset < bytes.length; offset += CRC_CHUNK)
    value = crc32(
      bytes.subarray(offset, Math.min(offset + CRC_CHUNK, bytes.length)),
      value,
    );
  return value >>> 0;
};

/** Continue a GNU debuglink CRC32 over the next streamed chunk. */
export const continueGnuDebuglinkCrc32 = (
  value: number,
  chunk: Buffer,
): number => crc32(chunk, value) >>> 0;

/** Eight lowercase hex digits for a GNU debuglink CRC32. */
export const gnuDebuglinkCrc32Hex = (bytes: Buffer): string =>
  crc32Hex(gnuDebuglinkCrc32(bytes));

const isRethrownBudget = (cause: unknown): boolean =>
  cause instanceof ElfNoteSectionNameBudgetFailure ||
  cause instanceof BinaryResourceFailure ||
  (cause instanceof ArtifactReaderFailure && cause.reason === "limit");

interface LocatedSection {
  readonly status: SectionStatus;
  readonly location: { offset: number; bytes: number } | null;
  readonly body: Buffer | null;
  readonly reason: "not_file_backed" | "compressed" | "duplicate" | null;
}

const locate = (
  bytes: Buffer,
  found: readonly ElfSection[],
  namesComplete: boolean,
): LocatedSection => {
  const section = found[0];
  if (section === undefined)
    return {
      status: namesComplete ? "absent" : "unknown",
      location: null,
      body: null,
      reason: null,
    };
  if (found.length > 1)
    return {
      status: "malformed",
      location: null,
      body: null,
      reason: "duplicate",
    };
  const location = locationOf(section);
  if (section.type === 8 || location === null || !inFile(section, bytes.length))
    return {
      status: "malformed",
      location: null,
      body: null,
      reason: "not_file_backed",
    };
  if (section.compressed)
    return {
      status: "unsupported",
      location,
      body: null,
      reason: "compressed",
    };
  return {
    status: "present",
    location,
    body: bytes.subarray(location.offset, location.offset + location.bytes),
    reason: null,
  };
};

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

const parseDebuglink = (
  bytes: Buffer,
  found: readonly ElfSection[],
  namesComplete: boolean,
  little: boolean,
): Report["debuglink"] => {
  const located = locate(bytes, found, namesComplete);
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
  if (located.status !== "present" || located.body === null)
    return closedDebuglink(located.status, null);
  const body = located.body;
  const nul = body.indexOf(0);
  if (nul < 0)
    return closedDebuglink(
      "malformed",
      "debuglink_unterminated_name",
      located.location,
    );
  const crcOffset = (nul + 1 + 3) & ~3;
  if (crcOffset + 4 > body.length)
    return closedDebuglink(
      "malformed",
      "debuglink_truncated",
      located.location,
    );
  const crc = little
    ? body.readUInt32LE(crcOffset)
    : body.readUInt32BE(crcOffset);
  const crcHex = crc32Hex(crc);
  if (nul === 0)
    return {
      status: "malformed",
      location: located.location,
      filename: null,
      crc32_hex: crcHex,
      reason: "debuglink_empty_name",
    };
  if (nul > MAX_ELF_DEBUG_LINK_NAME_BYTES)
    return {
      status: "malformed",
      location: located.location,
      filename: null,
      crc32_hex: crcHex,
      reason: "debuglink_name_exceeds_limit",
    };
  return {
    status: "present",
    location: located.location,
    filename: untrustedName(body.toString("latin1", 0, nul)),
    crc32_hex: crcHex,
    reason: null,
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

const parseDebugaltlink = (
  bytes: Buffer,
  found: readonly ElfSection[],
  namesComplete: boolean,
): Report["debugaltlink"] => {
  const located = locate(bytes, found, namesComplete);
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
  if (located.status !== "present" || located.body === null)
    return closedAlt(located.status, null);
  const body = located.body;
  const nul = body.indexOf(0);
  if (nul < 0)
    return closedAlt(
      "malformed",
      "debugaltlink_unterminated_name",
      located.location,
    );
  const build = body.subarray(nul + 1);
  const nameOk = nul > 0 && nul <= MAX_ELF_DEBUG_LINK_NAME_BYTES;
  const nameTooLong = nul > MAX_ELF_DEBUG_LINK_NAME_BYTES;
  const buildOk =
    build.length > 0 && build.length <= MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES;
  const buildTooLong = build.length > MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES;
  const filename = nameOk
    ? untrustedName(body.toString("latin1", 0, nul))
    : null;
  const buildHex = buildOk ? build.toString("hex") : null;
  if (build.length === 0)
    return {
      status: "malformed",
      location: located.location,
      filename,
      build_id_hex: null,
      reason: "debugaltlink_missing_build_id",
    };
  if (nul === 0)
    return {
      status: "malformed",
      location: located.location,
      filename: null,
      build_id_hex: buildHex,
      reason: "debugaltlink_empty_name",
    };
  if (nameTooLong)
    return {
      status: "malformed",
      location: located.location,
      filename: null,
      build_id_hex: buildTooLong ? null : buildHex,
      reason: "debugaltlink_name_exceeds_limit",
    };
  if (buildTooLong)
    return {
      status: "malformed",
      location: located.location,
      filename,
      build_id_hex: null,
      reason: "debugaltlink_build_id_exceeds_limit",
    };
  return {
    status: "present",
    location: located.location,
    filename,
    build_id_hex: buildHex,
    reason: null,
  };
};

const parseDebugdata = (
  bytes: Buffer,
  found: readonly ElfSection[],
  namesComplete: boolean,
): Report["debugdata"] => {
  const located = locate(bytes, found, namesComplete);
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
  if (located.status !== "present" || located.body === null)
    return {
      status: located.status,
      location: null,
      xz_magic: null,
      reason: null,
    };
  const body = located.body;
  if (body.length < XZ_MAGIC.length)
    return {
      status: "malformed",
      location: located.location,
      xz_magic: false,
      reason: "debugdata_truncated",
    };
  const magic = body.subarray(0, XZ_MAGIC.length).equals(XZ_MAGIC);
  return {
    status: magic ? "present" : "malformed",
    location: located.location,
    xz_magic: magic,
    reason: magic ? null : "debugdata_not_xz",
  };
};

interface ObservedBuildId {
  readonly buildId: BuildId;
  readonly limitation: string | null;
}

const unknownBuildId = (
  reason:
    | "note_tables_malformed"
    | "note_tables_unsupported"
    | "build_id_exceeds_limit",
  limitation: string | null,
): ObservedBuildId => ({
  buildId: { status: "unknown", hex: null, ids: [], reason },
  limitation,
});

const observeBuildId = (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectElfDebugLinkInput,
): ObservedBuildId => {
  let notes: ReturnType<typeof parseElfNotes>;
  try {
    notes = parseElfNotes(bytes, artifact, {
      path: artifact.path,
      max_file_bytes: input.max_file_bytes,
      max_entries: input.max_entries,
    });
  } catch (cause) {
    if (isRethrownBudget(cause)) throw cause;
    if (cause instanceof ArtifactReaderFailure && cause.reason === "format")
      return unknownBuildId(
        "note_tables_malformed",
        `ELF note tables could not be decoded: ${cause.message}`,
      );
    if (cause instanceof BinaryFormatFailure)
      return unknownBuildId(
        cause.kind === "unsupported"
          ? "note_tables_unsupported"
          : "note_tables_malformed",
        `ELF note tables could not be decoded: ${cause.message}`,
      );
    throw cause;
  }
  const ids: string[] = [];
  for (const entry of notes.entries) {
    const hex = entry.gnu?.build_id_hex;
    if (hex === null || hex === undefined || hex.length === 0) continue;
    if (!ids.includes(hex)) ids.push(hex);
  }
  if (ids.some((id) => id.length > MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES * 2))
    return unknownBuildId(
      "build_id_exceeds_limit",
      "A GNU build-id exceeds 256 bytes and was not copied.",
    );
  if (ids.length === 0)
    return {
      buildId: { status: "absent", hex: null, ids: [], reason: null },
      limitation: null,
    };
  if (ids.length > 1)
    return {
      buildId: {
        status: "conflict",
        hex: null,
        ids,
        reason: "multiple_build_ids",
      },
      limitation: ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
    };
  const hex = ids[0] ?? null;
  return {
    buildId: { status: "observed", hex, ids, reason: null },
    limitation: null,
  };
};

const sectionsNamed = (
  sections: readonly ElfSection[],
  name: string,
): readonly ElfSection[] => sections.filter((section) => section.name === name);

/** Decode separate-debug linkage from one in-memory ELF image. */
export const parseElfDebugLink = (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectElfDebugLinkInput,
): Report => {
  const image = readElfImage(bytes);
  const sections = image.sections.filter(
    (section): section is ElfSection => section.format === "elf",
  );
  const namesComplete =
    image.section_names_limitation === undefined &&
    sections.every((section) => section.name !== null);
  const little = image.byte_order === "little";
  const debuglink = parseDebuglink(
    bytes,
    sectionsNamed(sections, ".gnu_debuglink"),
    namesComplete,
    little,
  );
  const debugaltlink = parseDebugaltlink(
    bytes,
    sectionsNamed(sections, ".gnu_debugaltlink"),
    namesComplete,
  );
  const debugdata = parseDebugdata(
    bytes,
    sectionsNamed(sections, ".gnu_debugdata"),
    namesComplete,
  );
  const observed = observeBuildId(bytes, artifact, input);
  const limitations: Limitations = [...ELF_DEBUG_LINK_LIMITATIONS];
  if (image.section_names_limitation !== undefined)
    limitations.push(image.section_names_limitation);
  if (observed.limitation !== null) limitations.push(observed.limitation);
  const filename = debuglink.filename?.text ?? null;
  if (filename !== null && !debugFileNameIsSingleSegment(filename))
    limitations.push(ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION);
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
      status: coverageIncomplete ? "incomplete" : "complete",
      examined_sections,
    },
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
  const status = (name: string): "present" | "absent" | "unknown" => {
    if (sections.some((section) => section.name === name)) return "present";
    return namesComplete ? "absent" : "unknown";
  };
  return { debug_info: status(".debug_info"), symtab: status(".symtab") };
};

/**
 * The candidate is decoded with the image's budgets. A candidate that exceeds
 * them leaves its identity unknown instead of failing the image report.
 */
const observeCandidateBuildId = (
  content: Buffer,
  artifact: Report["artifact"],
  input: InspectElfDebugLinkInput,
): ObservedBuildId | null => {
  try {
    return observeBuildId(content, artifact, input);
  } catch (cause) {
    if (isRethrownBudget(cause)) return null;
    throw cause;
  }
};

const hasElfMagic = (bytes: Buffer): boolean =>
  bytes.length >= 4 && bytes.toString("hex", 0, 4) === "7f454c46";

const readCandidateIdentity = (
  content: Buffer,
  totalBytes: number,
  artifact: Report["artifact"],
  input: InspectElfDebugLinkInput,
): {
  readonly format: NonNullable<Report["candidate"]>["format"];
  readonly byte_order: NonNullable<Report["candidate"]>["byte_order"];
  readonly sections: Pick<
    NonNullable<Report["candidate"]>,
    "debug_info" | "symtab"
  >;
  readonly identity: CandidateIdentity;
  readonly budgetExceeded: boolean;
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
        buildId: { status: "unknown", hex: null, ids: [], reason: null },
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
        buildId: { status: "absent", hex: null, ids: [], reason: null },
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
        buildId: { status: "unknown", hex: null, ids: [], reason: null },
        candidateHex: null,
      },
      budgetExceeded: false,
    };
  let image: ReturnType<typeof readElfImage> | null = null;
  let imageMalformed = false;
  let imageBudgetExceeded = false;
  try {
    image = readElfImage(content);
  } catch (cause) {
    if (isRethrownBudget(cause)) imageBudgetExceeded = true;
    else imageMalformed = true;
  }
  const observed = observeCandidateBuildId(content, artifact, input);
  const buildId: BuildId = observed?.buildId ?? {
    status: "unknown",
    hex: null,
    ids: [],
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
    budgetExceeded: imageBudgetExceeded || observed === null,
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
): Report => {
  const identityArtifact = {
    path: candidate.path,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
  };
  const read = readCandidateIdentity(
    candidate.prefix,
    candidate.bytes,
    identityArtifact,
    input,
  );
  const crc = crcCheck(report.debuglink.crc32_hex, candidate.crc32);
  const build = buildIdCheck(report.build_id, read.identity);
  const verification = verificationOf(crc, build);
  const limitations = [...report.limitations];
  if (candidate.prefix.length !== candidate.bytes)
    limitations.push(ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION);
  if (read.budgetExceeded)
    limitations.push(ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION);
  if (
    verification.status === "matches" &&
    (crc.status === "unavailable" || build.status === "unavailable")
  )
    limitations.push(ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION);
  if (verification.status === "cannot_verify")
    limitations.push(ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION);
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
    limitations,
  };
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
  limitations: [
    ...report.limitations,
    ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
    ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ],
});

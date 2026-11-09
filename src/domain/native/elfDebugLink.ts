import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { ELF_OBJECT_TYPE_NAMES } from "./elfNotes.js";

const uint = z.number().int().min(0).max(0xffffffff);
const crc32Hex = z.string().regex(/^[0-9a-f]{8}$/u);
const buildIdHex = z.string().regex(/^(?:[0-9a-f]{2}){1,256}$/u);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES = 536870912;
/** Hard ceiling on note entries read while collecting GNU build-ids. */
export const MAX_INSPECT_ELF_DEBUG_LINK_ENTRIES = 256;
/** Retained debuglink and debugaltlink file-name length. */
export const MAX_ELF_DEBUG_LINK_NAME_BYTES = 4096;
/** Retained build-id length for debugaltlink and GNU notes. */
export const MAX_ELF_DEBUG_ALT_BUILD_ID_BYTES = 256;
/** Conventional GNU/Linux separate-debug directory. Not opened by this tool. */
export const GNU_DEBUG_DIRECTORY = "/usr/lib/debug";

/**
 * Standing caveats. Every result includes these sentences. A missing section
 * is absence only when section names are complete, and lookup strings are not
 * filesystem probes.
 */
export const ELF_DEBUG_LINK_LIMITATIONS = [
  "This workflow does not execute the image, search the filesystem for debug files, or use the network.",
  "Lookup paths are conventional GNU/Linux strings. They are not opened.",
  "The listed lookup paths are the build-id path, <directory>/.debug/<name>, and /usr/lib/debug/<directory>/<name>. A same-directory <directory>/<name> string is not included.",
  "Target-derived file names and lookup paths are untrusted data.",
  "The .gnu_debugdata xz payload is not decoded. Presence, file offset, and stored size are reported.",
  "A missing named section is observed absence only when section names are complete.",
  "GNU build-id absence means the declared note tables had no build-id. It is not proof the image never carried one.",
  "Candidate verification compares this image's debuglink CRC32 and GNU build-id with one caller-selected file. The .gnu_debugaltlink build-id is not that comparison.",
  "Debuglink and debugaltlink names use a byte-preserving Latin1 projection. Their original text encoding is unobserved.",
] as const;

/** One CRC32 or build-id comparison was unavailable, so a match is partial. */
export const ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION =
  "An unavailable CRC32 or build-id check is not a match.";

/** Neither CRC32 nor GNU build-id could be compared with the candidate. */
export const ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION =
  "Neither the debuglink CRC32 nor the GNU build-id could be compared with the candidate.";

/** The candidate exceeded the parse budget and was streamed for CRC32 only. */
export const ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION =
  "The candidate is larger than max_file_bytes. Its CRC32 and SHA-256 cover the whole file, but its sections and GNU build-id were not decoded.";

/** The candidate exceeded a decoding budget, so part of its identity is unknown. */
export const ELF_DEBUG_LINK_CANDIDATE_BUDGET_LIMITATION =
  "The candidate exceeded the max_entries or ELF decoding budget. Its CRC32 and SHA-256 cover the whole file, but candidate facts that were not decoded are unknown.";

/** The candidate could not be read as one stable regular file. */
export const ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION =
  "The selected candidate could not be read as one unchanged regular file, so it was not compared.";

/** A failed candidate phase retains the image report without any comparison. */
export const ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION =
  "The candidate read did not complete, so the candidate was not compared. Only the image linkage is retained.";

/**
 * Whole-file ceiling for a streamed candidate. Only `max_file_bytes` of it is
 * retained for ELF decoding; the rest is hashed in bounded chunks.
 */
export const MAX_ELF_DEBUG_CANDIDATE_BYTES = 0xffffffff;

/** Distinct GNU build-ids were observed and none is selected. */
export const ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION =
  "Multiple distinct GNU build-ids were observed. None is selected as the image build-id.";

/** The debuglink name is not one path segment, so directory strings are omitted. */
export const ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION =
  "The debuglink file name is not a single path segment, so directory lookup paths were not derived.";

const sectionStatus = z.enum([
  "present",
  "absent",
  "unknown",
  "malformed",
  "unsupported",
]);

const range = z.strictObject({ offset: uint, bytes: uint });

const untrustedName = z.strictObject({
  text: z.string().min(1).max(MAX_ELF_DEBUG_LINK_NAME_BYTES),
  encoding: z.literal("latin1"),
  trust: z.literal("observed-untrusted"),
});

const DEBUGLINK_REASONS = [
  "debuglink_not_file_backed",
  "debuglink_section_compressed",
  "debuglink_unterminated_name",
  "debuglink_empty_name",
  "debuglink_truncated",
  "debuglink_duplicate_section",
  "debuglink_name_exceeds_limit",
] as const;

const ALT_REASONS = [
  "debugaltlink_not_file_backed",
  "debugaltlink_section_compressed",
  "debugaltlink_unterminated_name",
  "debugaltlink_empty_name",
  "debugaltlink_missing_build_id",
  "debugaltlink_duplicate_section",
  "debugaltlink_name_exceeds_limit",
  "debugaltlink_build_id_exceeds_limit",
] as const;

const DEBUGDATA_REASONS = [
  "debugdata_not_file_backed",
  "debugdata_section_compressed",
  "debugdata_truncated",
  "debugdata_not_xz",
  "debugdata_duplicate_section",
] as const;

const BUILD_ID_REASONS = [
  "note_tables_malformed",
  "note_tables_unsupported",
  "multiple_build_ids",
  "build_id_exceeds_limit",
] as const;

const LOOKUP_KINDS = [
  "build_id",
  "debug_subdirectory",
  "global_debug_directory",
  "alt_build_id",
] as const;

const CANDIDATE_SECTION_STATUSES = [
  "present",
  "absent",
  "unknown",
  "not_elf",
] as const;

const CHECK_STATUSES = ["match", "mismatch", "unavailable"] as const;

const BUILD_ID_CHECK_REASONS = [
  "binary_build_id_absent",
  "binary_build_id_unknown",
  "binary_build_id_conflict",
  "candidate_not_elf",
  "candidate_build_id_absent",
  "candidate_build_id_unknown",
  "candidate_build_id_conflict",
  "candidate_elf_malformed",
  "candidate_unreadable",
] as const;

const VERIFICATION_REASONS = [
  "crc32_mismatch",
  "build_id_mismatch",
  "crc32_and_build_id_mismatch",
  "no_comparable_identity",
  "candidate_unreadable",
] as const;

/** Complete bounded inspection of separate debug-file linkage for one ELF. */
export const inspectElfDebugLinkInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an ELF32/ELF64 image",
  ),
  candidate_path: absoluteLocalPathStringSchema
    .optional()
    .describe(
      "Optional absolute path of one caller-selected file to verify against the debuglink CRC32 and GNU build-id",
    ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_ELF_DEBUG_LINK_ENTRIES)
    .default(32)
    .describe(
      "Maximum note entries to examine while reading GNU build-ids; an image exceeding the budget fails without partial success, and a candidate exceeding it leaves its build-id check unavailable",
    ),
});

const debuglinkSchema = z.strictObject({
  status: sectionStatus,
  location: range.nullable(),
  filename: untrustedName.nullable(),
  crc32_hex: crc32Hex.nullable(),
  reason: z.enum(DEBUGLINK_REASONS).nullable(),
});

const debugaltlinkSchema = z.strictObject({
  status: sectionStatus,
  location: range.nullable(),
  filename: untrustedName.nullable(),
  build_id_hex: buildIdHex.nullable(),
  reason: z.enum(ALT_REASONS).nullable(),
});

const debugdataSchema = z.strictObject({
  status: sectionStatus,
  location: range.nullable(),
  xz_magic: z.boolean().nullable(),
  reason: z.enum(DEBUGDATA_REASONS).nullable(),
});

/** One GNU build-id note that contributed an id, with its file ranges. */
const buildIdSourceSchema = z.strictObject({
  hex: buildIdHex,
  table_kind: z.enum(["program", "section"]),
  table_index: uint,
  note: range,
  descriptor: range,
});

const buildIdSchema = z.strictObject({
  status: z.enum(["observed", "absent", "unknown", "conflict"]),
  hex: buildIdHex.nullable(),
  ids: z.array(buildIdHex),
  sources: z.array(buildIdSourceSchema),
  reason: z.enum(BUILD_ID_REASONS).nullable(),
});

const lookupPathSchema = z.strictObject({
  kind: z.enum(LOOKUP_KINDS),
  path: z.string().min(1),
  trust: z.literal("observed-untrusted"),
});

const candidateSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: uint,
  format: z.enum(["elf32", "elf64"]).nullable(),
  byte_order: z.enum(["little", "big"]).nullable(),
  debug_info: z.enum(CANDIDATE_SECTION_STATUSES),
  symtab: z.enum(CANDIDATE_SECTION_STATUSES),
});

const crc32CheckSchema = z.strictObject({
  status: z.enum(CHECK_STATUSES),
  expected_hex: crc32Hex.nullable(),
  observed_hex: crc32Hex.nullable(),
  reason: z.enum(["debuglink_crc_absent", "candidate_unreadable"]).nullable(),
});

const buildIdCheckSchema = z.strictObject({
  status: z.enum(CHECK_STATUSES),
  binary_hex: buildIdHex.nullable(),
  candidate_hex: buildIdHex.nullable(),
  reason: z.enum(BUILD_ID_CHECK_REASONS).nullable(),
});

const verificationSchema = z.strictObject({
  status: z.enum(["matches", "does_not_match", "cannot_verify"]),
  reason: z.enum(VERIFICATION_REASONS).nullable(),
  crc32: crc32CheckSchema,
  build_id: buildIdCheckSchema,
});

/**
 * Observed separate-debug linkage. Lookup paths are derived strings. A missing
 * named section is absence only when section names are complete.
 */
export const elfDebugLinkSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["elf32", "elf64"]),
  byte_order: z.enum(["little", "big"]),
  machine: uint,
  type: uint,
  type_name: z.enum(ELF_OBJECT_TYPE_NAMES),
  debuglink: debuglinkSchema,
  debugaltlink: debugaltlinkSchema,
  debugdata: debugdataSchema,
  build_id: buildIdSchema,
  lookup_paths: z.array(lookupPathSchema),
  candidate: candidateSchema.nullable(),
  verification: verificationSchema.nullable(),
  coverage: z.strictObject({
    status: z.enum(["complete", "incomplete"]),
    examined_sections: uint,
  }),
  limitations: z.array(z.string()),
});

export type ElfDebugLink = z.infer<typeof elfDebugLinkSchema>;
export type InspectElfDebugLinkInput = z.infer<
  typeof inspectElfDebugLinkInputSchema
>;
export type ElfDebugFileLookupPath = ElfDebugLink["lookup_paths"][number];

/** A debug file name that can be appended as one path segment. */
export const debugFileNameIsSingleSegment = (name: string): boolean =>
  name !== "." && name !== ".." && /^[^/\\]+$/u.test(name);

const buildIdDirectoryPath = (hex: string | null): string | null => {
  if (hex === null || !/^(?:[0-9a-f]{2})+$/u.test(hex)) return null;
  return `${GNU_DEBUG_DIRECTORY}/.build-id/${hex.slice(0, 2)}/${hex.slice(2)}.debug`;
};

/** Directory text of one caller-selected image path, split by its own flavour. */
const imageDirectory = (
  binaryPath: string,
): {
  readonly directory: string;
  readonly separator: "/" | "\\";
  readonly globalRelative: string;
} => {
  // A drive-qualified or backslash-rooted path is a Windows absolute path; a
  // POSIX name may contain a literal backslash, so only Windows splits on it.
  const drive = /^([A-Za-z]):[\\/]/u.exec(binaryPath);
  const windows = drive !== null || binaryPath.startsWith("\\");
  const slash = windows
    ? Math.max(binaryPath.lastIndexOf("/"), binaryPath.lastIndexOf("\\"))
    : binaryPath.lastIndexOf("/");
  const directory = slash <= 0 ? "" : binaryPath.slice(0, slash);
  if (!windows)
    return { directory, separator: "/", globalRelative: directory.slice(1) };
  // GDB keeps the drive letter as one directory below the global debug root.
  const letter = drive?.[1];
  const rest = letter === undefined ? directory : directory.slice(2);
  const segments = rest.split(/[\\/]+/u).filter((part) => part.length > 0);
  return {
    directory,
    separator: "\\",
    globalRelative: [
      ...(letter === undefined ? [] : [letter]),
      ...segments,
    ].join("/"),
  };
};

/**
 * Conventional GNU/Linux lookup strings for one image. The strings keep `..`
 * segments. A Windows image path keeps its own directory text and separator
 * for the `.debug` string. This function does not open or search the filesystem.
 */
export const deriveDebugFileLookupPaths = (input: {
  readonly binaryPath: string;
  readonly debuglinkName: string | null;
  readonly buildIdHex: string | null;
  readonly altBuildIdHex: string | null;
}): ElfDebugFileLookupPath[] => {
  const paths: ElfDebugFileLookupPath[] = [];
  const buildId = buildIdDirectoryPath(input.buildIdHex);
  if (buildId !== null)
    paths.push({
      kind: "build_id",
      path: buildId,
      trust: "observed-untrusted",
    });
  if (
    input.debuglinkName !== null &&
    debugFileNameIsSingleSegment(input.debuglinkName)
  ) {
    const { directory, separator, globalRelative } = imageDirectory(
      input.binaryPath,
    );
    const name = input.debuglinkName;
    paths.push({
      kind: "debug_subdirectory",
      path: `${directory}${separator}.debug${separator}${name}`,
      trust: "observed-untrusted",
    });
    paths.push({
      kind: "global_debug_directory",
      path:
        globalRelative.length === 0
          ? `${GNU_DEBUG_DIRECTORY}/${name}`
          : `${GNU_DEBUG_DIRECTORY}/${globalRelative}/${name}`,
      trust: "observed-untrusted",
    });
  }
  const alt = buildIdDirectoryPath(input.altBuildIdHex);
  if (alt !== null)
    paths.push({
      kind: "alt_build_id",
      path: alt,
      trust: "observed-untrusted",
    });
  return paths;
};

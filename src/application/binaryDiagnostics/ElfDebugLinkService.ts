import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElfDebugLinkPort } from "./ElfDebugLinkPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  debugFileNameIsSingleSegment,
  deriveDebugFileLookupPaths,
  elfDebugLinkSchema,
  ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION,
  ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION,
  ELF_DEBUG_LINK_LIMITATIONS,
  ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION,
  ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION,
  ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION,
  inspectElfDebugLinkInputSchema,
  type ElfDebugLink,
  type InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import { BINARY_ARCHITECTURES } from "../../domain/binaryTargetTypes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_elf_debug_link";

type Range = { readonly offset: number; readonly bytes: number };

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class ElfDebugLinkService {
  constructor(readonly provider: ElfDebugLinkPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectElfDebugLinkInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = elfDebugLinkSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "ELF debug-link provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = BINARY_ARCHITECTURES.find(
      (supported) => supported === elfArchitecture(value.machine),
    );
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...(value.candidate === null
        ? []
        : [{ kind: "artifact-path" as const, path: value.candidate.path }]),
      ...rangesOf(value).map((range) => ({
        kind: "file-offset-range" as const,
        start: range.offset,
        end: range.offset + range.bytes,
      })),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "elf",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations,
        },
      ),
      options?.signal,
    );
  }
}

const inside =
  (fileBytes: number) =>
  (range: Range): boolean =>
    range.bytes <= fileBytes && range.offset <= fileBytes - range.bytes;

const rangesOf = (report: ElfDebugLink): Range[] => {
  const found: Range[] = [];
  const add = (range: Range | null): void => {
    if (range !== null) found.push(range);
  };
  add(report.debuglink.location);
  add(report.debugaltlink.location);
  add(report.debugdata.location);
  return found;
};

const nameLiterals = (name: ElfDebugLink["debuglink"]["filename"]): boolean =>
  name === null ||
  (name.encoding === "latin1" && name.trust === "observed-untrusted");

const debuglinkConsistent = (section: ElfDebugLink["debuglink"]): boolean => {
  if (!nameLiterals(section.filename)) return false;
  if (section.status === "absent" || section.status === "unknown")
    return (
      section.location === null &&
      section.filename === null &&
      section.crc32_hex === null &&
      section.reason === null
    );
  if (section.status === "present")
    return (
      section.location !== null &&
      section.filename !== null &&
      section.crc32_hex !== null &&
      section.reason === null
    );
  if (section.status === "unsupported")
    return (
      section.reason === "debuglink_section_compressed" &&
      section.location !== null &&
      section.filename === null &&
      section.crc32_hex === null
    );
  if (
    section.reason === "debuglink_duplicate_section" ||
    section.reason === "debuglink_not_file_backed"
  )
    return (
      section.location === null &&
      section.filename === null &&
      section.crc32_hex === null
    );
  if (
    section.reason === "debuglink_empty_name" ||
    section.reason === "debuglink_name_exceeds_limit"
  )
    return (
      section.location !== null &&
      section.filename === null &&
      section.crc32_hex !== null
    );
  if (
    section.reason === "debuglink_unterminated_name" ||
    section.reason === "debuglink_truncated"
  )
    return (
      section.location !== null &&
      section.filename === null &&
      section.crc32_hex === null
    );
  return false;
};

const altConsistent = (section: ElfDebugLink["debugaltlink"]): boolean => {
  if (!nameLiterals(section.filename)) return false;
  if (section.status === "absent" || section.status === "unknown")
    return (
      section.location === null &&
      section.filename === null &&
      section.build_id_hex === null &&
      section.reason === null
    );
  if (section.status === "present")
    return (
      section.location !== null &&
      section.filename !== null &&
      section.build_id_hex !== null &&
      section.reason === null
    );
  if (section.status === "unsupported")
    return (
      section.reason === "debugaltlink_section_compressed" &&
      section.location !== null &&
      section.filename === null &&
      section.build_id_hex === null
    );
  if (
    section.reason === "debugaltlink_duplicate_section" ||
    section.reason === "debugaltlink_not_file_backed"
  )
    return (
      section.location === null &&
      section.filename === null &&
      section.build_id_hex === null
    );
  if (section.location === null) return false;
  if (section.reason === "debugaltlink_unterminated_name")
    return section.filename === null && section.build_id_hex === null;
  if (section.reason === "debugaltlink_missing_build_id")
    return section.build_id_hex === null;
  if (section.reason === "debugaltlink_empty_name")
    return section.filename === null;
  if (section.reason === "debugaltlink_name_exceeds_limit")
    return section.filename === null;
  if (section.reason === "debugaltlink_build_id_exceeds_limit")
    return section.filename !== null && section.build_id_hex === null;
  return false;
};

const debugdataConsistent = (section: ElfDebugLink["debugdata"]): boolean => {
  if (section.status === "absent" || section.status === "unknown")
    return (
      section.location === null &&
      section.xz_magic === null &&
      section.reason === null
    );
  if (section.status === "present")
    return (
      section.location !== null &&
      section.xz_magic === true &&
      section.reason === null
    );
  if (section.status === "unsupported")
    return (
      section.reason === "debugdata_section_compressed" &&
      section.location !== null &&
      section.xz_magic === null
    );
  if (
    section.reason === "debugdata_duplicate_section" ||
    section.reason === "debugdata_not_file_backed"
  )
    return section.location === null && section.xz_magic === null;
  if (
    section.reason === "debugdata_truncated" ||
    section.reason === "debugdata_not_xz"
  )
    return section.location !== null && section.xz_magic === false;
  return false;
};

const buildIdConsistent = (buildId: ElfDebugLink["build_id"]): boolean => {
  if (buildId.status === "observed")
    return (
      buildId.hex !== null &&
      buildId.reason === null &&
      buildId.ids.length === 1 &&
      buildId.ids[0] === buildId.hex
    );
  if (buildId.status === "absent")
    return (
      buildId.hex === null &&
      buildId.ids.length === 0 &&
      buildId.reason === null
    );
  if (buildId.status === "unknown")
    return (
      buildId.hex === null &&
      buildId.ids.length === 0 &&
      (buildId.reason === "note_tables_malformed" ||
        buildId.reason === "note_tables_unsupported" ||
        buildId.reason === "build_id_exceeds_limit")
    );
  return (
    buildId.hex === null &&
    buildId.ids.length >= 2 &&
    buildId.reason === "multiple_build_ids"
  );
};

const checkStatusAgrees = (
  status: "match" | "mismatch" | "unavailable",
  left: string | null,
  right: string | null,
  reason: string | null,
): boolean => {
  if (status === "match")
    return left !== null && left === right && reason === null;
  if (status === "mismatch")
    return left !== null && right !== null && left !== right && reason === null;
  return reason !== null;
};

/** An unreadable candidate keeps the image linkage and compares nothing. */
const unreadableAgrees = (
  report: ElfDebugLink,
  verification: NonNullable<ElfDebugLink["verification"]>,
): boolean =>
  verification.status === "cannot_verify" &&
  verification.reason === "candidate_unreadable" &&
  verification.crc32.status === "unavailable" &&
  verification.crc32.reason === "candidate_unreadable" &&
  verification.crc32.expected_hex === report.debuglink.crc32_hex &&
  verification.crc32.observed_hex === null &&
  verification.build_id.status === "unavailable" &&
  verification.build_id.reason === "candidate_unreadable" &&
  verification.build_id.binary_hex ===
    (report.build_id.status === "observed" ? report.build_id.hex : null) &&
  verification.build_id.candidate_hex === null;

const verificationAgrees = (report: ElfDebugLink): boolean => {
  const verification = report.verification;
  if (verification === null) return report.candidate === null;
  const crc = verification.crc32;
  const build = verification.build_id;
  if (report.candidate === null) return unreadableAgrees(report, verification);
  if (
    verification.reason === "candidate_unreadable" ||
    crc.reason === "candidate_unreadable" ||
    build.reason === "candidate_unreadable"
  )
    return false;
  if (
    !checkStatusAgrees(
      crc.status,
      crc.expected_hex,
      crc.observed_hex,
      crc.reason,
    )
  )
    return false;
  if (
    !checkStatusAgrees(
      build.status,
      build.binary_hex,
      build.candidate_hex,
      build.reason,
    )
  )
    return false;
  if (crc.status === "unavailable") {
    if (crc.reason !== "debuglink_crc_absent" || crc.expected_hex !== null)
      return false;
    if (report.debuglink.crc32_hex !== null) return false;
  } else if (crc.expected_hex !== report.debuglink.crc32_hex) return false;
  if (build.status === "match" || build.status === "mismatch") {
    if (
      report.build_id.status !== "observed" ||
      build.binary_hex !== report.build_id.hex
    )
      return false;
  } else if (
    build.reason === "binary_build_id_absent" &&
    report.build_id.status !== "absent"
  )
    return false;
  else if (
    build.reason === "binary_build_id_unknown" &&
    report.build_id.status !== "unknown"
  )
    return false;
  else if (
    build.reason === "binary_build_id_conflict" &&
    report.build_id.status !== "conflict"
  )
    return false;
  else if (
    (build.reason === "candidate_not_elf" ||
      build.reason === "candidate_build_id_absent" ||
      build.reason === "candidate_build_id_unknown" ||
      build.reason === "candidate_build_id_conflict" ||
      build.reason === "candidate_elf_malformed") &&
    report.build_id.status !== "observed"
  )
    return false;
  const mismatches =
    (crc.status === "mismatch" ? 1 : 0) + (build.status === "mismatch" ? 1 : 0);
  const matches =
    (crc.status === "match" ? 1 : 0) + (build.status === "match" ? 1 : 0);
  if (mismatches === 2)
    return (
      verification.status === "does_not_match" &&
      verification.reason === "crc32_and_build_id_mismatch"
    );
  if (crc.status === "mismatch")
    return (
      verification.status === "does_not_match" &&
      verification.reason === "crc32_mismatch"
    );
  if (build.status === "mismatch")
    return (
      verification.status === "does_not_match" &&
      verification.reason === "build_id_mismatch"
    );
  if (matches > 0)
    return verification.status === "matches" && verification.reason === null;
  return (
    verification.status === "cannot_verify" &&
    verification.reason === "no_comparable_identity"
  );
};

const MALFORMED_CANDIDATE_BUILD_ID_REASONS: ReadonlySet<string> = new Set([
  "candidate_elf_malformed",
  "binary_build_id_absent",
  "binary_build_id_unknown",
  "binary_build_id_conflict",
]);

const candidateAgrees = (
  candidate: NonNullable<ElfDebugLink["candidate"]>,
  buildIdReason: string | null | undefined,
): boolean => {
  const headerMissing = candidate.format === null;
  if (headerMissing !== (candidate.byte_order === null)) return false;
  const notElf =
    candidate.debug_info === "not_elf" && candidate.symtab === "not_elf";
  // ELF magic with an unusable fixed header: no format, sections unknown.
  // The build-id reason names the candidate only when the binary has one.
  const malformedHeader =
    headerMissing &&
    MALFORMED_CANDIDATE_BUILD_ID_REASONS.has(buildIdReason ?? "") &&
    candidate.debug_info === "unknown" &&
    candidate.symtab === "unknown";
  if (malformedHeader) return true;
  if (headerMissing !== notElf) return false;
  if (
    !headerMissing &&
    (candidate.debug_info === "not_elf" || candidate.symtab === "not_elf")
  )
    return false;
  return true;
};

const examinedAgrees = (report: ElfDebugLink): boolean => {
  const found = [
    report.debuglink,
    report.debugaltlink,
    report.debugdata,
  ].filter(
    (section) => section.status !== "absent" && section.status !== "unknown",
  ).length;
  if (report.coverage.examined_sections < found) return false;
  const allAbsent =
    report.debuglink.status === "absent" &&
    report.debugaltlink.status === "absent" &&
    report.debugdata.status === "absent";
  return !allAbsent || report.coverage.examined_sections === 0;
};

const coverageAgrees = (report: ElfDebugLink): boolean => {
  const unknown =
    report.debuglink.status === "unknown" ||
    report.debugaltlink.status === "unknown" ||
    report.debugdata.status === "unknown" ||
    report.build_id.status === "unknown";
  if (unknown && report.coverage.status !== "incomplete") return false;
  return true;
};

const limitationAgrees = (report: ElfDebugLink): boolean => {
  if (
    !ELF_DEBUG_LINK_LIMITATIONS.every((line) =>
      report.limitations.includes(line),
    )
  )
    return false;
  const filename = report.debuglink.filename?.text ?? null;
  const segmentLimited =
    filename !== null && !debugFileNameIsSingleSegment(filename);
  if (
    segmentLimited !==
    report.limitations.includes(ELF_DEBUG_LINK_NAME_SEGMENT_LIMITATION)
  )
    return false;
  if (
    (report.build_id.status === "conflict") !==
    report.limitations.includes(ELF_DEBUG_LINK_MULTIPLE_BUILD_IDS_LIMITATION)
  )
    return false;
  const verification = report.verification;
  if (verification === null) return true;
  if (
    (verification.reason === "candidate_unreadable") !==
    report.limitations.includes(ELF_DEBUG_LINK_CANDIDATE_UNREADABLE_LIMITATION)
  )
    return false;
  const partialMatch =
    verification.status === "matches" &&
    (verification.crc32.status === "unavailable" ||
      verification.build_id.status === "unavailable");
  if (
    partialMatch !==
    report.limitations.includes(ELF_DEBUG_LINK_UNAVAILABLE_CHECK_LIMITATION)
  )
    return false;
  return (
    (verification.status === "cannot_verify") ===
    report.limitations.includes(ELF_DEBUG_LINK_CANNOT_VERIFY_LIMITATION)
  );
};

const lookupAgrees = (report: ElfDebugLink): boolean => {
  if (
    !report.lookup_paths.every((entry) => entry.trust === "observed-untrusted")
  )
    return false;
  const expected = deriveDebugFileLookupPaths({
    binaryPath: report.artifact.path,
    debuglinkName: report.debuglink.filename?.text ?? null,
    buildIdHex:
      report.build_id.status === "observed" ? report.build_id.hex : null,
    altBuildIdHex: report.debugaltlink.build_id_hex,
  });
  return JSON.stringify(report.lookup_paths) === JSON.stringify(expected);
};

const validReport = (
  report: ElfDebugLink,
  input: InspectElfDebugLinkInput,
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.type_name !== elfObjectTypeName(report.type) ||
    !rangesOf(report).every(inside(report.artifact.bytes)) ||
    report.build_id.ids.length > input.max_entries
  )
    return false;
  if (
    !debuglinkConsistent(report.debuglink) ||
    !altConsistent(report.debugaltlink) ||
    !debugdataConsistent(report.debugdata) ||
    !buildIdConsistent(report.build_id) ||
    !examinedAgrees(report) ||
    !coverageAgrees(report) ||
    !lookupAgrees(report) ||
    !limitationAgrees(report) ||
    !verificationAgrees(report)
  )
    return false;
  if (input.candidate_path === undefined)
    return report.candidate === null && report.verification === null;
  if (report.verification === null) return false;
  const candidate = report.candidate;
  if (candidate === null)
    return !report.limitations.includes(
      ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION,
    );
  // A candidate above max_file_bytes was streamed whole for CRC32 and SHA-256
  // but only its ELF header was decoded.
  const streamed = candidate.bytes > input.max_file_bytes;
  if (
    candidate.path !== input.candidate_path ||
    streamed !==
      report.limitations.includes(ELF_DEBUG_LINK_CANDIDATE_PREFIX_LIMITATION) ||
    (streamed &&
      candidate.format !== null &&
      (candidate.debug_info !== "unknown" || candidate.symtab !== "unknown"))
  )
    return false;
  return candidateAgrees(candidate, report.verification?.build_id.reason);
};

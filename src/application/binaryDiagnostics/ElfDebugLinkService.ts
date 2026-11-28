import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElfDebugLinkPort } from "../../ports/binaryDiagnostics/ElfDebugLinkPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  debugFileNameIsSingleSegment,
  deriveDebugFileLookupPaths,
  elfDebugLinkSchema,
  inspectElfDebugLinkInputSchema,
  type ElfDebugLink,
  type ElfDebugLinkLimitationCode,
  type InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import {
  createElfDebugLinkEvidence,
  elfDebugLinkRanges,
  type ElfDebugLinkRange,
} from "../../domain/native/elfDebugLinkEvidence.js";
import { err, type Result } from "../../domain/result.js";
import {
  completeProviderEvidence,
  retainCompletedArtifactEvidence,
} from "../ProviderOperationExecution.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";

const OPERATION = "inspect_elf_debug_link";

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
    const parameters = callerAnalysisParameters(rawInput)(input.value);
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) {
      const source = result.error.partialObservation;
      const partial = elfDebugLinkSchema.safeParse(source);
      if (
        partial.success &&
        partial.data.artifact.path === input.value.path &&
        validReport(partial.data, input.value, "partial")
      ) {
        const evidence = createElfDebugLinkEvidence(
          partial.data,
          this.provider.identity,
          parameters,
        );
        retainCompletedArtifactEvidence(result.error, evidence);
      }
      return result;
    }
    const report = elfDebugLinkSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value, "complete")
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "ELF debug-link provider returned malformed output or changed artifact identity.",
        ),
      );
    return completeProviderEvidence(
      createElfDebugLinkEvidence(
        report.data,
        this.provider.identity,
        parameters,
      ),
      options?.signal,
    );
  }
}

const inside =
  (fileBytes: number) =>
  (range: ElfDebugLinkRange): boolean =>
    range.bytes <= fileBytes && range.offset <= fileBytes - range.bytes;

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
    // Unsupported storage and oversized notes can coexist with readable IDs.
    return (
      buildId.hex === null &&
      (buildId.reason === "build_id_exceeds_limit" ||
        buildId.reason === "note_tables_unsupported" ||
        (buildId.reason === "note_tables_malformed" &&
          buildId.ids.length === 0))
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

const verificationAgrees = (
  report: ElfDebugLink,
  verification: NonNullable<ElfDebugLink["verification"]>,
): boolean => {
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
  if (unknown && report.coverage.status !== "partial") return false;
  return true;
};

const CANDIDATE_VERIFICATION_LIMITATION_CODES: readonly ElfDebugLinkLimitationCode[] =
  [
    "candidate_prefix_only",
    "candidate_budget_exceeded",
    "candidate_unreadable",
    "unavailable_check",
    "cannot_verify",
  ];

const limitationAgrees = (
  report: ElfDebugLink,
  codes: ReadonlySet<ElfDebugLinkLimitationCode>,
): boolean => {
  if (report.limitations.length === 0 || !codes.has("standing_caveats"))
    return false;
  const filename = report.debuglink.filename?.text ?? null;
  const segmentLimited =
    filename !== null && !debugFileNameIsSingleSegment(filename);
  if (segmentLimited !== codes.has("name_not_single_segment")) return false;
  if (
    (report.build_id.status === "conflict") !==
    codes.has("multiple_build_ids")
  )
    return false;
  const verification = report.verification;
  if (verification === null)
    return !CANDIDATE_VERIFICATION_LIMITATION_CODES.some((code) =>
      codes.has(code),
    );
  if (
    (verification.reason === "candidate_unreadable") !==
    codes.has("candidate_unreadable")
  )
    return false;
  const partialMatch =
    verification.status === "matches" &&
    (verification.crc32.status === "unavailable" ||
      verification.build_id.status === "unavailable");
  if (partialMatch !== codes.has("unavailable_check")) return false;
  return (
    (verification.status === "cannot_verify") === codes.has("cannot_verify")
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
  outcome: "complete" | "partial",
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.type_name !== elfObjectTypeName(report.type) ||
    !elfDebugLinkRanges(report).every(inside(report.artifact.bytes)) ||
    report.build_id.ids.length > input.max_entries
  )
    return false;
  const codes = new Set(report.limitation_codes);
  if (
    !debuglinkConsistent(report.debuglink) ||
    !altConsistent(report.debugaltlink) ||
    !debugdataConsistent(report.debugdata) ||
    !buildIdConsistent(report.build_id) ||
    !examinedAgrees(report) ||
    !coverageAgrees(report) ||
    !lookupAgrees(report) ||
    !limitationAgrees(report, codes)
  )
    return false;
  const { candidate, verification } = report;
  const readIncomplete = codes.has("candidate_read_incomplete");
  const comparisonIncomplete = codes.has("candidate_comparison_incomplete");
  if (input.candidate_path === undefined)
    return (
      candidate === null &&
      verification === null &&
      !readIncomplete &&
      !comparisonIncomplete
    );
  if (candidate !== null && candidate.path !== input.candidate_path)
    return false;
  if (verification === null) {
    if (outcome === "complete") return false;
    if (candidate === null) return readIncomplete && !comparisonIncomplete;
    return (
      comparisonIncomplete &&
      !readIncomplete &&
      candidate.format === null &&
      candidate.byte_order === null &&
      candidate.debug_info === "unknown" &&
      candidate.symtab === "unknown"
    );
  }
  if (
    readIncomplete ||
    comparisonIncomplete ||
    !verificationAgrees(report, verification)
  )
    return false;
  if (candidate === null) return !codes.has("candidate_prefix_only");
  // A candidate above max_file_bytes was streamed whole for CRC32 and SHA-256
  // but only its ELF header was decoded.
  const streamed = candidate.bytes > input.max_file_bytes;
  if (
    streamed !== codes.has("candidate_prefix_only") ||
    (streamed &&
      candidate.format !== null &&
      (candidate.debug_info !== "unknown" || candidate.symtab !== "unknown"))
  )
    return false;
  return candidateAgrees(candidate, verification.build_id.reason);
};

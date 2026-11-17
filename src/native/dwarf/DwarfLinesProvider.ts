import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { requireSelectedNativeImage } from "../../domain/apple/machoSliceSelection.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { DWARF_LINES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  DWARF_DECOMPRESSED_SECTION_ALLOWANCE,
  DWARF_LINE_LIMITATIONS,
  MAX_INSPECT_DWARF_LINES_FILE_BYTES,
  formatDwarfLineAddress,
  type DwarfLinesReport,
  type InspectDwarfLinesInput,
} from "../../domain/native/dwarfLines.js";
import { MAX_DWARF_DECOMPRESSED_SECTION_BYTES } from "../../domain/native/dwarfUnits.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
} from "../../domain/parseFailure.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok } from "../../domain/result.js";
import { errorMessage } from "../../kernel/errorMessage.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { DwarfLinesPort } from "../../ports/binaryDiagnostics/DwarfLinesPort.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  type StableArtifactSnapshot,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  bindArtifactFileCleanup,
  completedStableArtifactObservation,
  imageFileSizeRemediation,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  translateArtifactFailure,
} from "../../resources/index.js";
import { parseDwarfLinePrograms } from "./DwarfLineParser.js";
import {
  DwarfSectionAllowanceFailure,
  locateDwarfLineSections,
} from "./DwarfSections.js";

const OPERATION = "inspect_dwarf_lines";

/** Decode DWARF `.debug_line` programs from one local ELF, Mach-O, or PE image. */
export class DwarfLinesProvider implements DwarfLinesPort {
  readonly identity = DWARF_LINES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        DWARF_LINES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectDwarfLinesInput, options?: ExecutionOptions) {
    let readCompleted = false;
    // Kept outside the read so a later decode/validation/cancellation failure
    // retains the verified file identity established by readStableArtifact.
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        readCompleted = true;
        assertArtifactReadActive(options?.signal);
        const report = readDwarfLinesFromBuffer(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      const failure = classifyProviderFailure(cause, {
        providerId: DWARF_LINES_PROVIDER.id,
        operation: OPERATION,
        file: {
          path: input.path,
          description: "image",
          retainCompletedIdentity: true,
          fileSize: (readerCause, details) =>
            parseLimitConstraint(
              OPERATION,
              "file-size",
              decodeLimit(
                "dwarf",
                readerCause.message,
                { name: "max_file_bytes", maximum: input.max_file_bytes },
                { cause: readerCause },
              ),
              {
                ...details,
                path: input.path,
                retryable: false,
                remediationAction: imageFileSizeRemediation(
                  input.max_file_bytes,
                  MAX_INSPECT_DWARF_LINES_FILE_BYTES,
                ),
              },
            ),
        },
        readCleanup: (read, primary) => {
          const createCleanupError = () => {
            const cleanup = new ProviderCleanupError(
              DWARF_LINES_PROVIDER.id,
              read.cleanup.resources,
              { reason: read.cleanup.reason },
              { operation: OPERATION, cause: read },
            );
            bindArtifactFileCleanup(read, cleanup);
            return cleanup;
          };
          if (primary === undefined) {
            const cleanup = createCleanupError();
            if (read.partialObservation !== undefined) {
              cleanup.retainPartialObservation(read.partialObservation);
            }
            return cleanup;
          }
          let leafPrimary = primary;
          while (leafPrimary.cleanupPrimary !== undefined) {
            leafPrimary = leafPrimary.cleanupPrimary;
          }
          if (primary === leafPrimary) {
            return projectStableArtifactFailure(
              read,
              leafPrimary,
              input.path,
              DWARF_LINES_PROVIDER.id,
              OPERATION,
              snapshot,
            );
          }
          const combinedCleanup = analysisErrorWithCleanupDependencies(
            primary,
            createCleanupError(),
            OPERATION,
          );
          const failure = analysisErrorWithCleanupDependencies(
            leafPrimary,
            combinedCleanup,
            OPERATION,
          );
          if (primary.partialObservation !== undefined) {
            failure.retainPartialObservation(primary.partialObservation);
          }
          if (read.partialObservation !== undefined) {
            failure.retainPartialObservation(read.partialObservation);
          }
          return failure;
        },
        recognise: (rawCause, details) => {
          const primary = artifactFilePrimaryFacts(rawCause).cause;
          if (primary instanceof AnalysisError) return primary;
          if (primary instanceof DwarfSectionAllowanceFailure) {
            return parseLimitConstraint(OPERATION, "capacity", primary, {
              ...details,
              path: input.path,
              ...fixedAllowanceOptions(
                DWARF_DECOMPRESSED_SECTION_ALLOWANCE,
                "parser",
                {
                  limit: MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
                  unit: "bytes",
                },
              ),
            });
          }
          if (primary instanceof BinaryResourceFailure) {
            return parseLimitConstraint(OPERATION, "capacity", primary, {
              ...details,
              path: input.path,
              ...fixedAllowanceOptions(
                DWARF_DECOMPRESSED_SECTION_ALLOWANCE,
                "parser",
                binaryResourceCeiling(primary),
              ),
            });
          }
          const field =
            primary instanceof ParseFailureError &&
            primary.failure.field === "program_offset"
              ? "program_offset"
              : "path";
          return parseFailureAnalysisError(
            OPERATION,
            input.path,
            primary,
            field,
          );
        },
        unclassified: (rawCause, details) => {
          const { cause: primary, origin } = artifactFilePrimaryFacts(rawCause);
          if (
            !readCompleted ||
            (origin === "owned-or-classified" &&
              primary instanceof ArtifactReaderFailure)
          ) {
            return primary instanceof ArtifactReaderFailure
              ? translateArtifactFailure(OPERATION, primary)
              : new ArtifactOperationError(
                  OPERATION,
                  "io",
                  undefined,
                  undefined,
                  { ...details, cause: primary },
                );
          }
          return new ProviderAdapterError(DWARF_LINES_PROVIDER.id, OPERATION, {
            ...details,
            cause: primary,
            diagnostics: {
              path: input.path,
              reason: errorMessage(primary),
            },
          });
        },
      });
      const observation = completedStableArtifactObservation(
        cause,
        input.path,
        snapshot,
      );
      if (observation !== undefined) {
        failure.retainPartialObservation(observation);
        for (
          let primary = failure.cleanupPrimary;
          primary !== undefined;
          primary = primary.cleanupPrimary
        ) {
          primary.retainPartialObservation(observation);
        }
      }
      return err(failure);
    }
  }
}

/** Decode `.debug_line` programs from one in-memory image snapshot. */
export const readDwarfLinesFromBuffer = (
  bytes: Buffer,
  artifact: DwarfLinesReport["artifact"],
  input: InspectDwarfLinesInput,
): DwarfLinesReport => {
  const selected = requireSelectedNativeImage(
    OPERATION,
    artifact.path,
    bytes,
    input.architecture,
  );
  const located = locateDwarfLineSections(selected.bytes);
  const sections = located.sections.map((section) => ({
    name: section.name,
    role: section.role,
    offset: selected.fileOffset + section.offset,
    size: section.size,
    compression: section.compression,
    uncompressed_size: section.uncompressed_size,
  }));
  const base = {
    artifact,
    format: located.format,
    bits: located.bits,
    byte_order: located.byte_order,
    machine: located.machine,
    architecture: located.architecture,
    ...(selected.selection === null
      ? {}
      : { selected_slice: selected.selection }),
    sections,
    omissions: [...located.omissions],
  };

  if (located.debugLine.state !== "read") {
    const unavailableStatus =
      located.debugLine.state === "unreadable" ? "unreadable" : "absent";
    if (input.program_offset !== undefined) {
      throw malformedInput(
        "dwarf",
        `Cannot read program_offset ${input.program_offset} when .debug_line is ${unavailableStatus}`,
        { offset: input.program_offset, field: "program_offset" },
      );
    }
    const addressStatus =
      unavailableStatus === "unreadable" ? "incomplete" : "not_found";
    const limitations = [
      DWARF_LINE_LIMITATIONS.targetDerived,
      DWARF_LINE_LIMITATIONS.childDiesOmitted,
      DWARF_LINE_LIMITATIONS.externalDebugUnfollowed,
      ...(located.format === "macho" ? [DWARF_LINE_LIMITATIONS.machoDsym] : []),
      ...(input.max_rows === 0
        ? [DWARF_LINE_LIMITATIONS.rowsOmittedByCaller]
        : []),
      ...selected.limitations,
    ];
    return {
      ...base,
      debug_line: unavailableStatus,
      selected_program_offset: null,
      programs: [],
      total_programs: 0,
      rows: [],
      total_rows: 0,
      address_matches: (input.addresses ?? []).map((raw) => ({
        query_address: formatDwarfLineAddress(BigInt(raw)),
        status: addressStatus,
        matches: [],
      })),
      coverage:
        located.debugLine.state === "unreadable"
          ? { status: "partial", reason: located.debugLine.reason }
          : { status: "complete", reason: null },
      limitations,
    };
  }

  const parsed = parseDwarfLinePrograms({
    line: located.line ?? Buffer.alloc(0),
    lineStr: located.lineStr,
    str: located.str,
    strOffsets: located.strOffsets,
    lineFileOffset:
      located.lineFileOffset === null
        ? null
        : selected.fileOffset + located.lineFileOffset,
    little: located.byte_order === "little",
    defaultAddressSize: located.bits === 64 ? 8 : 4,
    ...(input.program_offset === undefined
      ? {}
      : { programOffset: input.program_offset }),
    ...(input.addresses === undefined ? {} : { addresses: input.addresses }),
    maxPrograms: input.max_programs,
    maxRows: input.max_rows,
    unappliedLineRelocations: located.unappliedLineRelocations,
    unappliedDebugRelocations: located.unappliedDebugRelocations,
  });

  const unreadCopies = located.debugLine.unreadCopies;
  const coverage =
    parsed.coverage.status === "complete" && unreadCopies > 0
      ? {
          status: "partial" as const,
          reason: `Image contains ${unreadCopies} additional .debug_line section(s) that were left unread`,
        }
      : parsed.coverage;

  const addressMatches =
    unreadCopies > 0
      ? parsed.address_matches.map((entry) =>
          entry.status === "not_found"
            ? { ...entry, status: "incomplete" as const }
            : entry,
        )
      : [...parsed.address_matches];

  const limitations = [
    ...parsed.limitations,
    ...(located.format === "macho" ? [DWARF_LINE_LIMITATIONS.machoDsym] : []),
    ...selected.limitations,
  ];

  return {
    ...base,
    debug_line: "present",
    selected_program_offset: parsed.selected_program_offset,
    programs: [...parsed.programs],
    total_programs: parsed.total_programs,
    rows: [...parsed.rows],
    total_rows: parsed.total_rows,
    address_matches: addressMatches,
    coverage,
    limitations,
  };
};

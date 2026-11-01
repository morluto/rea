import {
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { DwarfUnitsPort } from "../../application/binaryDiagnostics/DwarfUnitsPort.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { DWARF_UNITS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  DWARF_DECOMPRESSED_SECTION_ALLOWANCE,
  dwarfUnitsSchema,
  MAX_INSPECT_DWARF_UNITS_FILE_BYTES,
  type DwarfUnitsReport,
  type InspectDwarfUnitsInput,
} from "../../domain/native/dwarfUnits.js";
import { err, ok } from "../../domain/result.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { requireSelectedNativeImage } from "../metadata/MachoSliceSelection.js";
import { parseDwarfCompileUnits } from "./DwarfUnitParser.js";
import {
  DwarfSectionAllowanceFailure,
  locateDwarfSections,
  type DebugInfoAvailability,
  type LocatedDwarfImage,
} from "./DwarfSections.js";

const OPERATION = "inspect_dwarf_units";

const CHILD_DIES =
  "Child DIEs, types, line tables, and location expressions are not read.";
const NO_DEBUG_INFO =
  "This file has no .debug_info section. That does not establish that a separate debug file is absent.";
const NO_FILE_BACKED_DEBUG_INFO =
  "This file has no file-backed .debug_info section. That does not establish that a separate debug file is absent.";

/** Portable parser over one bounded, identity-checked regular file. */
export class DwarfUnitsProvider implements DwarfUnitsPort {
  readonly identity = DWARF_UNITS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        DWARF_UNITS_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectDwarfUnitsInput, options?: ExecutionOptions) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        const selected = requireSelectedNativeImage(
          OPERATION,
          input.path,
          snapshot.bytes,
          input.architecture,
        );
        const located = locateDwarfSections(selected.bytes);
        const report = dwarfUnitsSchema.parse(
          buildReport(
            input,
            snapshot,
            selected.fileOffset,
            selected.selection,
            located,
          ),
        );
        return ok(report);
      });
    } catch (cause) {
      return err(dwarfUnitsFailure(cause, input));
    }
  }
}

const buildReport = (
  input: InspectDwarfUnitsInput,
  snapshot: { readonly sha256: string; readonly bytes: Buffer },
  fileOffset: number,
  selection: DwarfUnitsReport["selected_slice"] | null,
  located: LocatedDwarfImage,
): unknown => {
  const sections = located.sections.map((section) => ({
    name: section.name,
    role: section.role,
    offset: section.offset + fileOffset,
    size: section.size,
    compression: section.compression,
    uncompressed_size: section.uncompressed_size,
  }));
  const infoFileOffset =
    located.infoFileOffset === null
      ? null
      : located.infoFileOffset + fileOffset;
  const walked =
    located.info === null
      ? {
          units: [],
          total_units: 0,
          coverage: missingInfoCoverage(located.debugInfo),
        }
      : parseDwarfCompileUnits({
          info: located.info,
          abbrev: located.abbrev,
          str: located.str,
          lineStr: located.lineStr,
          strOffsets: located.strOffsets,
          little: located.byte_order === "little",
          infoFileOffset,
          pageOffset: input.offset,
          pageLimit: input.limit,
          debugRelocationsUnapplied:
            located.unappliedDebugRelocations.length > 0,
        });
  const coverage = withUnreadCopies(walked.coverage, located.debugInfo);
  return {
    artifact: {
      path: input.path,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
    },
    format: located.format,
    bits: located.bits,
    byte_order: located.byte_order,
    machine: located.machine,
    architecture: located.architecture,
    ...(selection === null || selection === undefined
      ? {}
      : { selected_slice: selection }),
    sections,
    omissions: located.omissions,
    units: walked.units,
    total_units: walked.total_units,
    page: { offset: input.offset, limit: input.limit },
    coverage,
    limitations: limitationsFor(located, coverage),
  };
};

/** A declared section whose bytes went undecoded is unknown, never absent. */
const missingInfoCoverage = (
  availability: DebugInfoAvailability,
): DwarfUnitsReport["coverage"] => {
  if (availability.state === "unreadable")
    return { status: "partial", reason: availability.reason };
  return {
    status: "no_debug_info",
    reason:
      availability.state === "no_contents"
        ? NO_FILE_BACKED_DEBUG_INFO
        : NO_DEBUG_INFO,
  };
};

const withUnreadCopies = (
  coverage: DwarfUnitsReport["coverage"],
  availability: DebugInfoAvailability,
): DwarfUnitsReport["coverage"] => {
  if (availability.state !== "read" || availability.unreadCopies === 0)
    return coverage;
  const unread = `${String(availability.unreadCopies)} further .debug_info section(s) were not read, so total_units covers the first only.`;
  return {
    status: "partial",
    reason: coverage.reason === null ? unread : `${coverage.reason} ${unread}`,
  };
};

const limitationsFor = (
  located: LocatedDwarfImage,
  coverage: DwarfUnitsReport["coverage"],
): string[] => {
  const limitations = [CHILD_DIES];
  if (located.format === "macho")
    limitations.push(
      "A .dSYM bundle is not opened. Pass the DWARF file inside the bundle.",
    );
  if (located.infoCompressed)
    limitations.push(
      "Unit offsets are within decompressed .debug_info and file_offset is null.",
    );
  if (coverage.reason !== null) limitations.push(coverage.reason);
  if (coverage.status === "no_debug_info" && located.format !== "macho")
    limitations.push(
      located.gnuDebugLink
        ? "A .gnu_debuglink section is present and its contents were not decoded. A GNU build-id note was not read."
        : ".gnu_debuglink was not observed in this file. A GNU build-id note was not read.",
    );
  if (located.unappliedDebugRelocations.length > 0)
    limitations.push(
      `Relocatable ELF (ET_REL) debug relocations were not applied (${located.unappliedDebugRelocations.join(", ")}). Relocated strings and stmt_list are unresolved, and a unit is decoded only when .debug_abbrev holds one table.`,
    );
  return limitations;
};

const inputBudgetRemediation = (input: InspectDwarfUnitsInput): string =>
  input.max_file_bytes >= MAX_INSPECT_DWARF_UNITS_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_DWARF_UNITS_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const dwarfUnitsFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectDwarfUnitsInput,
) => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (cause instanceof DwarfSectionAllowanceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      {
        section: cause.section,
        required_bytes: cause.requiredBytes.toString(),
        maximum_bytes: cause.maximumBytes,
      },
      {
        cause,
        ...fixedAllowanceOptions(
          DWARF_DECOMPRESSED_SECTION_ALLOWANCE,
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { maximum_bytes: cause.maximum_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The native structural decoding allowance",
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          {
            cause,
          },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      {
        cause,
      },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: inputBudgetRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected image could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "DWARF compile-unit inspection failed.",
    { cause },
  );
};

const dwarfUnitsFailure = (cause: unknown, input: InspectDwarfUnitsInput) => {
  const primary = dwarfUnitsFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    DWARF_UNITS_PROVIDER.id,
    OPERATION,
  );
};

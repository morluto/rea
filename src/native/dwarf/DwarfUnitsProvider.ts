import {
  closeArtifactResources,
  projectStableArtifactFailure,
  withStableArtifactHandle,
  yieldArtifactRead,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  projectZstandardFrameAllowance,
  ZstandardFrameAllowanceError,
} from "../../domain/compression/zstandardFrameAllowance.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { DWARF_UNITS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  dwarfDecompressedLimit,
  dwarfUnitsSchema,
  type DwarfUnitsReport,
  dwarfUnitsFileLimit,
  type InspectDwarfUnitsInput,
} from "../../domain/native/dwarfUnits.js";
import { err, ok } from "../../domain/result.js";
import {
  binaryResourceCeiling,
  BinaryResourceFailure,
  isNativeStructureFailure,
} from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
import { requireSelectedNativeImageFromReader } from "../../domain/apple/machoSliceSelection.js";
import { parseDwarfCompileUnits } from "./DwarfUnitParser.js";
import {
  DWARF_RETAINED_SECTIONS_LIMIT,
  DwarfSectionAllowanceFailure,
  locateDwarfSectionsFromHandle,
  type DebugInfoAvailability,
  type LocatedDwarfImage,
} from "./DwarfSections.js";

const OPERATION = "inspect_dwarf_units";
const HEADER_PREFIX_BYTES = 4096;

const CHILD_DIES =
  "Child DIEs, types, line tables, and location expressions are not read.";
const NO_DEBUG_INFO =
  "This file has no .debug_info section. That does not establish that a separate debug file is absent.";
const NO_FILE_BACKED_DEBUG_INFO =
  "This file has no file-backed .debug_info section. That does not establish that a separate debug file is absent.";

/** Portable parser over one bounded, identity-checked regular file. */
/**
 * Satisfies the application's DwarfUnitsPort structurally; composition
 * checks the fit, so this provider does not import the application layer.
 */
export class DwarfUnitsProvider {
  readonly identity = DWARF_UNITS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      DWARF_UNITS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectDwarfUnitsInput,
    options?: { readonly signal?: AbortSignal },
  ) {
    // Kept outside the read so a later decoding failure still reports the
    // file identity the read established.
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              snapshot = identity;
            },
          },
          async (handle) => {
            const selected = await requireSelectedNativeImageFromReader(
              OPERATION,
              input.path,
              handle,
              input.architecture,
            );
            const located = await locateDwarfSectionsFromHandle(
              selected.source,
              input.max_decompressed_bytes,
              async () => {
                await yieldArtifactRead(options?.signal);
              },
              input.max_structure_bytes,
            );
            return dwarfUnitsSchema.parse(
              buildReport(
                input,
                { sha256: handle.sha256, bytes: handle.size },
                selected.fileOffset,
                selected.selection,
                located,
              ),
            );
          },
        );
        return ok(report);
      });
    } catch (cause) {
      return err(dwarfUnitsFailure(cause, input, snapshot));
    }
  }
}

const buildReport = (
  input: InspectDwarfUnitsInput,
  snapshot: { readonly sha256: string; readonly bytes: number },
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
  const absence = debugInfoAbsence(located.debugInfo);
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
      bytes: snapshot.bytes,
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
    debug_info: absence === null ? "present" : "absent",
    omissions: located.omissions,
    units: walked.units,
    total_units: walked.total_units,
    page: { offset: input.offset, limit: input.limit },
    coverage,
    limitations: limitationsFor(located, coverage, absence),
  };
};

/**
 * Why this file holds no file-backed .debug_info, or null when it declares
 * one. A declared section whose bytes went undecoded is unknown, never absent.
 */
const debugInfoAbsence = (availability: DebugInfoAvailability): string | null =>
  availability.state === "no_contents"
    ? NO_FILE_BACKED_DEBUG_INFO
    : availability.state === "absent"
      ? NO_DEBUG_INFO
      : null;

/** Examining a file without .debug_info is complete; an unreadable one is not. */
const missingInfoCoverage = (
  availability: DebugInfoAvailability,
): DwarfUnitsReport["coverage"] =>
  availability.state === "unreadable"
    ? { status: "partial", reason: availability.reason }
    : { status: "complete", reason: null };

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
  absence: string | null,
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
  if (absence !== null) limitations.push(absence);
  if (absence !== null && located.format !== "macho")
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

const dwarfUnitsFailure = (
  cause: unknown,
  input: InspectDwarfUnitsInput,
  snapshot: { readonly sha256: string; readonly bytes: number } | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: DWARF_UNITS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "ELF, Mach-O or PE image",
      fallbackMessage: "DWARF compile-unit inspection failed.",
      recognise: (failure) => {
        if (failure instanceof ZstandardFrameAllowanceError)
          return projectZstandardFrameAllowance(OPERATION, failure);
        if (failure instanceof DwarfSectionAllowanceFailure)
          // Sections decompress in turn, so the need is known only so far.
          return parseLimitConstraint(OPERATION, "memory", failure, {
            retryable: false,
            limit: dwarfDecompressedLimit(failure.failure.limit.maximum),
          });
        if (isNativeStructureFailure(failure))
          return nativeStructureConstraint(OPERATION, failure);
        if (
          failure instanceof BinaryResourceFailure &&
          failure.failure.limit.name === DWARF_RETAINED_SECTIONS_LIMIT
        )
          return parseLimitConstraint(
            OPERATION,
            "memory",
            failure,
            fixedAllowanceOptions(
              "The retained DWARF section bound",
              "parser",
              binaryResourceCeiling(failure),
            ),
          );
        return undefined;
      },
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "dwarf",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: dwarfUnitsFileLimit(input.max_file_bytes),
          },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    DWARF_UNITS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};

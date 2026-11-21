import { discoverRasterRegistryFamily } from "../../domain/rasterRegistryFamily.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { discoverStructuredRasters } from "../../domain/structuredRasterDiscovery.js";
import {
  materializeRasterSegments,
  parseFgsRasterSegments,
} from "../../domain/rasterLogicalSegments.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import type { z } from "zod";
import type { inspectStructuredRasterCandidatesInputSchema } from "../../domain/native/structuredRasterCandidates.js";
export type StructuredRasterAnalysisInput = Pick<
  z.infer<typeof inspectStructuredRasterCandidatesInputSchema>,
  | "path"
  | "offset"
  | "length"
  | "profile"
  | "segments"
  | "grammar"
  | "min_records"
  | "min_consistency"
  | "max_work"
  | "max_tables"
  | "max_records"
  | "bits_per_pixel"
  | "offset_units"
  | "resource_family"
  | "family_max_work"
>;

/** Shared preparation for discovery and export; all offsets remain materialized-relative. */
export function prepareStructuredRasterAnalysis(
  bytes: Uint8Array,
  input: StructuredRasterAnalysisInput,
  fileSize: number,
  signal?: AbortSignal,
  operation = "inspect_structured_raster_candidates",
) {
  const invalid = (field: string, message: string) =>
    new AnalysisInputError(operation, undefined, [
      { path: [field], reason: "invalid_value", message },
    ]);
  if (input.profile === "fgs-records" && bytes.length !== fileSize)
    throw invalid("length", "fgs-records requires the complete selected file");
  const mappedInput = <T>(field: string, action: () => T): T => {
    try {
      return action();
    } catch (cause) {
      if (
        isParseLimit(cause, "fgs-records") ||
        isParseLimit(cause, "raster-logical-segments")
      ) {
        const { limit } = cause.failure;
        const countLimit =
          limit.name === "raster-logical-segment-count" ||
          limit.name === "fgs-record-count";
        throw parseLimitConstraint(operation, "capacity", cause, {
          path: input.path,
          ...fixedAllowanceOptions(limit.name, countLimit ? "count" : "bytes", {
            limit: limit.maximum,
            unit: countLimit ? "entries" : "bytes",
          }),
        });
      }
      const formatFailure = parseFailureAnalysisError(
        operation,
        input.path,
        cause,
        field,
      );
      if (formatFailure !== undefined) throw formatFailure;
      throw cause;
    }
  };
  const segments =
    input.segments ??
    (input.profile === "fgs-records"
      ? mappedInput("path", () => parseFgsRasterSegments(bytes))
      : [
          {
            logicalOffset: input.offset,
            fileOffset: input.offset,
            length: bytes.length,
          },
        ]);
  const logical = mappedInput(input.segments ? "segments" : "path", () =>
    materializeRasterSegments(bytes, segments, input.offset),
  );
  const report = discoverStructuredRasters(
    logical.bytes,
    {
      ...(input.grammar === undefined ? {} : { grammar: input.grammar }),
      coverage: logical.coverage,
      minRecords: input.min_records,
      minConsistency: input.min_consistency,
      maxWork: input.max_work,
      maxTables: input.max_tables,
      maxRecords: input.max_records,
      bitsPerPixel: input.bits_per_pixel,
      offsetUnits: input.offset_units,
    },
    signal,
  );
  const family =
    input.resource_family === "record12-lut-registry"
      ? discoverRasterRegistryFamily(
          logical.bytes,
          report,
          logical.coverage,
          { maxWork: input.family_max_work },
          signal,
        )
      : undefined;
  return { logical, report, family };
}

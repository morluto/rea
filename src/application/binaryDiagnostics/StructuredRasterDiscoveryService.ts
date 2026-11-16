import { discoverStructuredRasters } from "../../domain/structuredRasterDiscovery.js";
import {
  materializeRasterSegments,
  parseFgsRasterSegments,
} from "../../domain/rasterLogicalSegments.js";
import {
  inspectStructuredRasterCandidatesInputSchema,
  structuredRasterCandidatesSchema,
} from "../../domain/native/structuredRasterCandidates.js";
import { SelectedRasterAnalysisService } from "./SelectedRasterAnalysisService.js";
import type { ArtifactResourceScope } from "../../resources/index.js";
import { renderIndexThumbnail } from "./IndexRasterThumbnail.js";
/** Configured descriptor grammar over explicitly mapped bytes, not firmware identification. */
export class StructuredRasterDiscoveryService extends SelectedRasterAnalysisService<
  ReturnType<typeof inspectStructuredRasterCandidatesInputSchema.parse>,
  ReturnType<typeof structuredRasterCandidatesSchema.parse>
> {
  constructor(
    files?: Pick<typeof import("node:fs/promises"), "open" | "stat">,
    resources?: ArtifactResourceScope,
  ) {
    super(
      {
        operation: "inspect_structured_raster_candidates",
        inputSchema: inspectStructuredRasterCandidatesInputSchema,
        reportSchema: structuredRasterCandidatesSchema,
        analyze(bytes, input, fileSize, signal) {
          if (
            input.profile === "fgs-records" &&
            (input.segments !== undefined ||
              input.offset !== 0 ||
              bytes.length !== fileSize)
          )
            throw new RangeError(
              "fgs-records requires the complete selected file and no explicit segments",
            );
          const segments =
            input.segments ??
            (input.profile === "fgs-records"
              ? parseFgsRasterSegments(bytes)
              : [
                  {
                    logicalOffset: input.offset,
                    fileOffset: input.offset,
                    length: bytes.length,
                  },
                ]);
          const logical = materializeRasterSegments(
            bytes,
            segments,
            input.offset,
          );
          const report = discoverStructuredRasters(
            logical.bytes,
            {
              ...(input.grammar === undefined
                ? {}
                : { grammar: input.grammar }),
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
          let returned = 0,
            previews = 0,
            mappingBudget = 256,
            mappingTruncated = false;
          const sourceMapping = (offset: number, length: number) => {
            const start = offset + logical.logicalBase,
              end = start + length;
            let cursor = start;
            const ranges: { offset: number; length: number }[] = [];
            if (mappingBudget === 0) {
              mappingTruncated = true;
              return { ranges, complete: false };
            }
            let lo = 0,
              hi = logical.segments.length;
            while (lo < hi) {
              const mid = Math.floor((lo + hi) / 2),
                s = logical.segments[mid]!;
              if (s.logicalOffset + s.length <= start) lo = mid + 1;
              else hi = mid;
            }
            for (let i = lo; i < logical.segments.length; i++) {
              const s = logical.segments[i]!;
              if (s.logicalOffset + s.length <= cursor) continue;
              if (s.logicalOffset >= end) break;
              if (s.logicalOffset > cursor) break;
              if (mappingBudget === 0) break;
              const take = Math.min(s.logicalOffset + s.length, end) - cursor;
              ranges.push({
                offset: s.fileOffset + cursor - s.logicalOffset,
                length: take,
              });
              mappingBudget--;
              cursor += take;
              if (cursor === end) break;
            }
            const complete = cursor === end;
            if (!complete && mappingBudget === 0) mappingTruncated = true;
            return { ranges, complete };
          };
          const available = report.tables.reduce(
            (n, t) => n + t.resources.length,
            0,
          );
          const selected = new Set(
            report.tables
              .flatMap((t) => t.resources)
              .slice(
                input.resource_offset,
                input.resource_offset + input.max_resources,
              ),
          );
          const tables = report.tables.map((t) => ({
            ...t,
            offset: t.offset + logical.logicalBase,
            resources: t.resources
              .filter((r) => selected.has(r))
              .map((r) => {
                returned++;
                const descriptorSourceMapping = sourceMapping(
                  r.descriptorOffset,
                  report.grammar.recordStride,
                );
                const unique =
                  r.status === "unique" ? r.hypotheses[0] : undefined;
                const preview =
                  previews < input.max_previews &&
                  unique?.covered &&
                  [1, 2, 4, 8].includes(unique.bitsPerPixel)
                    ? renderIndexThumbnail(
                        logical.bytes,
                        {
                          width: r.width,
                          height: r.height,
                          payloadOffset: unique.payloadRange.offset,
                          bitsPerPixel: unique.bitsPerPixel,
                        },
                        input.thumbnail_side,
                      )
                    : undefined;
                if (preview) previews++;
                return {
                  ...r,
                  descriptorOffset: r.descriptorOffset + logical.logicalBase,
                  descriptorSourceMapping,
                  hypotheses: r.hypotheses.map((h) => ({
                    ...h,
                    sourceMapping: sourceMapping(
                      h.payloadRange.offset,
                      h.payloadRange.length,
                    ),
                    payloadRange: {
                      ...h.payloadRange,
                      offset: h.payloadRange.offset + logical.logicalBase,
                    },
                  })),
                  ...(preview ? { preview } : {}),
                };
              }),
          }));
          const coveredBytes = logical.coverage.reduce(
            (n, r) => n + r.length,
            0,
          );
          return {
            ...report,
            tables,
            coverage: {
              ...report.coverage,
              nextOffset:
                report.coverage.nextOffset === null
                  ? null
                  : report.coverage.nextOffset + logical.logicalBase,
            },
            mapping: {
              profile: input.segments ? "explicit-segments" : input.profile,
              logicalBase: logical.logicalBase,
              logicalBytes: logical.bytes.length,
              segmentCount: logical.segments.length,
              coveredBytes,
              uncoveredBytes: logical.bytes.length - coveredBytes,
              sourceMappingsTruncated: mappingTruncated,
            },
            projection: {
              availableResources: available,
              returnedResources: returned,
              resourceOffset: input.resource_offset,
              nextResourceOffset:
                input.resource_offset + returned < available
                  ? input.resource_offset + returned
                  : null,
              resourcesTruncated: returned < available,
              previews,
            },
            limitations: [
              ...report.limitations,
              ...logical.assumptions,
              "Descriptor/table/payloadRange offsets are logical coordinates; sourceMapping ranges are whole-file byte coordinates. Encoded payloadOffset remains the original relative field.",
              "Pagination repeats analysis deterministically; keep artifact SHA-256, grammar and search options unchanged between pages.",
              "Source mappings have a shared 256-span publication budget; incomplete mappings are explicit and do not invalidate separately established logical coverage.",
              "Index-only previews use artificial gray levels, MSB-first packing and top-down rows. Original palette, colors, transparency and orientation remain unknown.",
            ],
          };
        },
      },
      files,
      resources,
    );
  }
}

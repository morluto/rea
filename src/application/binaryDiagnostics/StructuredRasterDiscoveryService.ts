import { walkRasterLogicalSegments } from "../../domain/rasterLogicalSegments.js";
import { createRasterPreviews } from "./StructuredRasterPreviews.js";
import { projectRasterFamily } from "./RasterFamilyProjection.js";
import { prepareStructuredRasterAnalysis } from "./StructuredRasterAnalysis.js";
import {
  inspectStructuredRasterCandidatesInputSchema,
  inspectStructuredRasterCandidatesRequestSchema,
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
        callerInputSchema: inspectStructuredRasterCandidatesRequestSchema,
        reportSchema: structuredRasterCandidatesSchema,
        async analyze(bytes, input, fileSize, signal) {
          const prepared = prepareStructuredRasterAnalysis(
            bytes,
            input,
            fileSize,
            signal,
          );
          const { logical, report, family } = prepared;
          let returned = 0,
            previews = 0,
            mappingBudget = 256,
            mappingTruncated = false;
          const sourceMapping = (offset: number, length: number) => {
            const ranges: { offset: number; length: number }[] = [];
            if (mappingBudget === 0) {
              mappingTruncated = true;
              return { ranges, complete: false };
            }
            const { complete, segmentCount } = walkRasterLogicalSegments(
              logical.segments,
              offset + logical.logicalBase,
              length,
              mappingBudget,
              (segment, cursor, take) =>
                ranges.push({
                  offset: segment.fileOffset + cursor - segment.logicalOffset,
                  length: take,
                }),
            );
            mappingBudget -= segmentCount;
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
          const colored = await createRasterPreviews(
            prepared,
            input,
            [...selected],
            signal,
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
                  input.color_policy &&
                  input.color_policy.kind !== "diagnostic-indices"
                    ? colored.get(r.descriptorOffset)?.preview
                    : previews < input.max_previews &&
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
                  ...(colored.get(r.descriptorOffset)?.previewUnavailable
                    ? {
                        previewUnavailable: colored.get(r.descriptorOffset)!
                          .previewUnavailable,
                      }
                    : {}),
                };
              }),
          }));
          const resourceFamily = family
            ? projectRasterFamily(
                family,
                logical.logicalBase,
                new Set([...selected].map((r) => r.descriptorOffset)),
                sourceMapping,
              )
            : undefined;
          const coveredBytes = logical.coverage.reduce(
            (n, r) => n + r.length,
            0,
          );
          return {
            ...report,
            tables,
            ...(resourceFamily ? { resourceFamily } : {}),
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
              ...(family?.limitations ?? []),
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

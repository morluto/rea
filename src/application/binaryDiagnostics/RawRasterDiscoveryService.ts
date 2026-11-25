import { discoverRawRaster } from "../../domain/rawRasterDiscovery.js";
import {
  inspectRawRasterCandidatesInputSchema,
  inspectRawRasterCandidatesRequestSchema,
  rawRasterDiscoverySchema,
} from "../../domain/native/rawRasterCandidates.js";
import { SelectedRasterAnalysisService } from "./SelectedRasterAnalysisService.js";
import { ArtifactResourceScope } from "../../resources/index.js";
/** Shared transport-independent raw heuristic workflow with bounded artifact ownership. */
export class RawRasterDiscoveryService extends SelectedRasterAnalysisService<
  ReturnType<typeof inspectRawRasterCandidatesInputSchema.parse>,
  ReturnType<typeof rawRasterDiscoverySchema.parse>
> {
  constructor(
    files?: Pick<typeof import("node:fs/promises"), "open" | "stat">,
    resources?: ArtifactResourceScope,
  ) {
    super(
      {
        operation: "inspect_raw_raster_candidates",
        inputSchema: inspectRawRasterCandidatesInputSchema,
        callerInputSchema: inspectRawRasterCandidatesRequestSchema,
        reportSchema: rawRasterDiscoverySchema,
        analyze(bytes, input, _fileSize, signal) {
          const report = discoverRawRaster(
            bytes,
            {
              widths: input.widths,
              heights: input.heights,
              formats: input.formats,
              ...(input.offset_step === undefined
                ? {}
                : { offsetStep: input.offset_step }),
              minScore: input.min_score,
              maxHypotheses: input.max_hypotheses,
              maxCandidates: input.max_candidates,
            },
            signal,
          );
          if (report.coverage.nextOffset !== null)
            report.coverage.nextOffset += input.offset;
          for (const c of report.candidates) c.layout.offset += input.offset;
          return {
            ...report,
            limitations: [
              ...report.limitations,
              "Candidate offsets are absolute file offsets.",
            ],
          };
        },
      },
      files,
      resources,
    );
  }
}

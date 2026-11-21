import { AnalysisArtifactChangedError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  createEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
} from "../../domain/evidence.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  exportStructuredRasterResourcesInputSchema,
  exportStructuredRasterResourcesRequestSchema,
  structuredRasterExportResultSchema,
  type StructuredRasterExportResult,
} from "../../domain/native/structuredRasterExport.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { ArtifactResourceScope } from "../../resources/index.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { SelectedRasterSnapshotReader } from "./SelectedRasterSnapshotReader.js";
import { prepareStructuredRasterAnalysis } from "./StructuredRasterAnalysis.js";
import {
  RasterExportPublication,
  RASTER_EXPORT_OPERATION,
  rasterExportFailureDialect,
} from "./RasterExportPublication.js";
import {
  planExport,
  invalid,
  type Prepared,
} from "./StructuredRasterExportPlan.js";
import {
  preflightExport,
  writeExport,
} from "./StructuredRasterExportArtifacts.js";
/** Write-capable operation; admitted source snapshot is fully released before output creation. */
export class StructuredRasterExportService {
  private readonly reader: SelectedRasterSnapshotReader;
  private readonly operations: ArtifactResourceScope;
  constructor(
    files?: Pick<typeof import("node:fs/promises"), "open" | "stat">,
    resources?: ArtifactResourceScope,
    private readonly publication = new RasterExportPublication(),
  ) {
    // The caller scope owns the entire export, not only source acquisition.
    // The reader needs an inner scope so closing the owner cannot recurse.
    this.operations = resources ?? new ArtifactResourceScope();
    this.reader = new SelectedRasterSnapshotReader(files);
    this.operations.addCloseHook(() => this.publication.close());
    this.operations.addCloseHook(() => this.reader.close());
  }
  close(): Promise<void> {
    return this.operations.close();
  }
  async export(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      return await this.operations.run(() =>
        this.exportOwned(rawInput, options),
      );
    } catch (cause) {
      return err(
        classifyProviderFailure(
          cause,
          rasterExportFailureDialect(options?.signal),
        ),
      );
    }
  }
  private async exportOwned(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = parseAnalysisInput(
      RASTER_EXPORT_OPERATION,
      rawInput,
      exportStructuredRasterResourcesInputSchema,
      options?.signal,
    );
    if (!parsed.ok) return parsed;
    const caller = parseAnalysisInput(
      RASTER_EXPORT_OPERATION,
      rawInput,
      exportStructuredRasterResourcesRequestSchema,
      options?.signal,
    );
    if (!caller.ok) return caller;
    const input = parsed.value;
    const read = await this.reader.read(
      input,
      RASTER_EXPORT_OPERATION,
      (s) => s,
      { signal: options?.signal },
    );
    if (!read.ok) return read;
    const snapshot = read.value;
    const evidence = (result: StructuredRasterExportResult) =>
      withEvidenceCallerInputPath(
        createEvidence(
          {
            path: snapshot.artifact.path,
            format: "file",
            sha256: snapshot.artifact.sha256,
          },
          REA_WORKFLOW_PROVIDER,
          {
            operation: RASTER_EXPORT_OPERATION,
            parameters: Object.fromEntries(
              Object.entries(caller.value).filter(
                ([, value]) => value !== undefined,
              ),
            ),
            result: structuredRasterExportResultSchema.parse(result),
            rawResult: null,
            confidence: "inferred",
            limitations: result.limitations,
            locations: [
              { kind: "artifact-path", path: input.output_directory },
            ],
          },
        ),
        input.path,
      );
    try {
      if (snapshot.artifact.sha256 !== input.expected_sha256.toLowerCase())
        throw new AnalysisArtifactChangedError(
          RASTER_EXPORT_OPERATION,
          input.path,
          "Expected SHA-256 does not match the admitted whole source file.",
        );
      if (
        input.color_policy.kind === "record12-lut-registry" &&
        input.resource_family !== "record12-lut-registry"
      )
        throw invalid(
          "color_policy",
          "Family color requires explicit resource_family=record12-lut-registry.",
        );
      const prepared: Prepared = prepareStructuredRasterAnalysis(
        snapshot.bytes,
        input,
        snapshot.artifact.bytes,
        options?.signal,
        RASTER_EXPORT_OPERATION,
      );
      const plans = planExport(prepared, input);
      preflightExport(plans, input, options?.signal);
      const result = await this.publication.publish(
        input.output_directory,
        (w) =>
          writeExport(w, {
            snapshot,
            prepared,
            input,
            plans,
            signal: options?.signal,
          }),
        evidence,
        options?.signal,
      );
      return ok(evidence(result));
    } catch (cause) {
      return err(
        classifyProviderFailure(
          cause,
          rasterExportFailureDialect(options?.signal),
        ).retainPartialObservation({
          kind: "file-snapshot-hash",
          ...snapshot.artifact,
        }),
      );
    }
  }
}

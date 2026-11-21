import type { z } from "zod";
import { setImmediate } from "node:timers/promises";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import {
  createEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
} from "../../domain/evidence.js";
import { err, type Result } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
} from "../../resources/index.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import { SelectedRasterSnapshotReader } from "./SelectedRasterSnapshotReader.js";
interface RasterAnalysisInput {
  path: string;
  offset: number;
  length?: number | undefined;
}
interface RasterAnalysisReport {
  artifact: { path: string; bytes: number; sha256: string };
  limitations: string[];
}
export interface SelectedRasterAnalysisDefinition<
  Input extends RasterAnalysisInput,
  Report extends RasterAnalysisReport,
> {
  operation: string;
  inputSchema: z.ZodType<Input>;
  callerInputSchema?: z.ZodType<{
    [Key in keyof Input]?: Input[Key] | undefined;
  }>;
  reportSchema: z.ZodType<Report>;
  analyze(
    bytes: Uint8Array,
    input: Input,
    fileSize: number,
    signal?: AbortSignal,
  ):
    | { limitations: string[]; [key: string]: unknown }
    | Promise<{ limitations: string[]; [key: string]: unknown }>;
}

/** Decode only inside the shared source owner; publish completed observations after cleanup. */
export class SelectedRasterAnalysisService<
  Input extends RasterAnalysisInput,
  Report extends RasterAnalysisReport,
> {
  private readonly reader: SelectedRasterSnapshotReader;
  private readonly operations: ArtifactResourceScope;
  constructor(
    private readonly definition: SelectedRasterAnalysisDefinition<
      Input,
      Report
    >,
    files?: Pick<typeof import("node:fs/promises"), "open" | "stat">,
    resources: ArtifactResourceScope = new ArtifactResourceScope(),
    platform: NodeJS.Platform = HOST_PLATFORM.platform,
  ) {
    this.operations = resources;
    this.reader = new SelectedRasterSnapshotReader(files, undefined, platform);
    this.operations.addCloseHook(() => this.reader.close());
  }
  close(): Promise<void> {
    return this.operations.close();
  }
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      return await this.operations.run(() =>
        this.inspectOwned(rawInput, options),
      );
    } catch (cause) {
      const error = new AnalysisOutputError(
        this.definition.operation,
        "Raster inspection ownership could not complete or release its resources.",
        {
          cause,
          ...(cause instanceof ArtifactReaderFailure &&
          cause.cleanup !== undefined
            ? { cleanup: cause.cleanup }
            : {}),
        },
      );
      bindArtifactFileCleanup(cause, error);
      return err(error);
    }
  }
  private async inspectOwned(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = parseAnalysisInput(
      this.definition.operation,
      rawInput,
      this.definition.inputSchema,
      options?.signal,
    );
    if (!parsed.ok) return parsed;
    const caller = parseAnalysisInput(
      this.definition.operation,
      rawInput,
      this.definition.callerInputSchema ?? this.definition.inputSchema,
      options?.signal,
    );
    if (!caller.ok) return caller;
    const input = parsed.value;
    const evidenceFromReport = (report: Report): Evidence =>
      withEvidenceCallerInputPath(
        createEvidence(
          {
            path: report.artifact.path,
            format: "file",
            sha256: report.artifact.sha256,
          },
          REA_WORKFLOW_PROVIDER,
          {
            operation: this.definition.operation,
            parameters: Object.fromEntries(
              Object.entries({
                ...caller.value,
                path: report.artifact.path,
              }).filter(([, value]) => value !== undefined),
            ),
            result: report,
            rawResult: null,
            confidence: "inferred",
            limitations: report.limitations,
            locations: [{ kind: "artifact-path", path: report.artifact.path }],
          },
        ),
        input.path,
      );
    const result = await this.reader.read(
      input,
      this.definition.operation,
      async (snapshot) => {
        const discovery = await this.definition.analyze(
          snapshot.bytes,
          { ...input, path: snapshot.artifact.path },
          snapshot.artifact.bytes,
          options?.signal,
        );
        return this.definition.reportSchema.parse({
          ...discovery,
          resolved_controls: Object.fromEntries(
            Object.entries({ ...input, length: snapshot.window.length }).filter(
              ([key, value]) => key !== "path" && value !== undefined,
            ),
          ),
          artifact: snapshot.artifact,
          window: snapshot.window,
          limitations: [
            ...discovery.limitations,
            "Artifact SHA-256 covers the entire file. Metadata matched before and after reading, not an immutable snapshot guarantee.",
            "Synchronous scoring checks cancellation between hypotheses; cancellation delivered by the event loop is observed before and after this bounded scoring phase.",
          ],
        });
      },
      {
        signal: options?.signal,
        completedObservation: (value) => {
          const report = this.definition.reportSchema.safeParse(value);
          return report.success ? evidenceFromReport(report.data) : undefined;
        },
      },
    );
    if (!result.ok) return result;
    await setImmediate();
    return completeProviderEvidence(
      evidenceFromReport(result.value),
      options?.signal,
    );
  }
}
